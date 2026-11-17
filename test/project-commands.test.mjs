import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { CommandRuns, commandProfile, commandDirectory } from '../app/project-commands.mjs';

async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timeout'); }
const quote = text => "'" + text.replaceAll("'", "''") + "'";
const commandFor = file => (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote(file);

test('project commands stream output before exit, repeat in a nested directory, stop process trees and persist interrupted history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-live-')), folder = join(root, 'web app');
  await mkdir(folder); let store = new Store(join(root, 'profile.sqlite')), runs;
  try {
    const chat = store.addProject('Web', root);
    const script = join(folder, 'test.cjs');
    await writeFile(script, 'console.log("FIRST Проверка");setTimeout(()=>{console.error("LAST");process.exit(7)},1500);');
    const profile = commandProfile({ directory: 'web app', runtime: process.execPath, commands: { test: commandFor(script) } });
    store.saveProfile(chat.projectId, profile);
    assert.deepEqual(store.profile(chat.projectId), profile);
    assert.throws(() => commandProfile({ directory: '../elsewhere' }));
    const output = []; runs = new CommandRuns(store, run => output.push(structuredClone(run)));
    const run = await runs.start({ chatId: chat.id, projectId: chat.projectId, root, profile, key: 'test' });
    await until(() => output.some(run => run.status === 'in_progress' && run.output.includes('FIRST')));
    await until(() => !runs.active.has(run.id));
    const result = store.command(run.id); assert.equal(result.exitCode, 7); assert.equal(result.status, 'failed'); assert.ok(result.output.includes('LAST') && result.output.includes('Проверка')); assert.equal(result.cwd, folder);
    const server = join(root, 'server.cjs'); await writeFile(server, 'console.log("READY");setInterval(()=>{},1000);');
    const live = await runs.start({ chatId: chat.id, projectId: chat.projectId, root, profile: {}, command: commandFor(server), cwd: '.' });
    await until(() => store.command(live.id).output.includes('READY'));
    runs.stop(live.id); await until(() => !runs.active.has(live.id)); assert.equal(store.command(live.id).status, 'interrupted');
    store.saveCommand({ ...live, id: 'interrupted', status: 'in_progress' });
    store.db.close(); store = new Store(join(root, 'profile.sqlite'));
    assert.equal(store.command('interrupted').status, 'interrupted'); assert.equal(store.command(run.id).exitCode, 7);
    assert.deepEqual(store.profile(chat.projectId), profile);
  } finally { await runs?.close(); store.db.close(); await rm(root, { recursive: true, force: true }); }
});
