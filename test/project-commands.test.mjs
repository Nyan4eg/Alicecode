import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { CommandRuns, commandProfile, commandDirectory } from '../app/project-commands.mjs';
import { fileRevision } from '../app/revision.mjs';
import { AffectedChecks } from '../app/affected-checks.mjs';
import { execFileSync } from 'node:child_process';

test('package profiles migrate lazily, persist per chat and hash only their Git-visible inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-scopes-'));
  const store = new Store(':memory:');
  t.after(async () => { store.db.close(); await rm(root,{recursive:true,force:true}); });
  execFileSync('git',['init','-q'],{cwd:root});
  for (const dir of ['api','web','shared']) await mkdir(join(root,dir));
  const chat = store.addProject('Packages',root);
  store.saveProfile(chat.projectId,{directory:'web',commands:{test:'node --test'}});
  assert.equal(commandProfile(store.selectedProfile(store.chat(chat.id))).name,'Весь проект');
  const api = commandProfile({id:'api',name:'API',directory:'api',scope:['api/','shared','lock.json']});
  store.putProfile(chat,api);
  assert.deepEqual(store.selectedProfile(store.chat(chat.id)),api);
  const other = store.addChat(chat.projectId);
  assert.equal(store.chat(other.id).profileId,'all');
  assert.throws(()=>commandProfile({scope:['../outside']}));
  const hash = async scope => (await fileRevision(root,scope)).version;
  const first = await hash(api.scope);
  await writeFile(join(root,'web','app.css'),'body{}');
  assert.equal(await hash(api.scope),first);
  await writeFile(join(root,'shared','types.ts'),'export type Id = string');
  assert.notEqual(await hash(api.scope),first);
  await rm(join(root,'shared','types.ts'));
  assert.equal(await hash(api.scope),first);
});

async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Timeout'); }

test('shared checks continue after API failure, reuse Web and invalidate only the CSS consumer', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'alicecode-impact-')));
  const store = new Store(':memory:'), commands = new CommandRuns(store, () => {});
  t.after(async () => { await commands.close(); store.db.close(); await rm(root,{recursive:true,force:true}); });
  execFileSync('git',['init','-q'],{cwd:root});
  for (const dir of ['web','api','shared']) await mkdir(join(root,dir));
  const chat = store.addProject('Packages',root);
  const checks = new AffectedChecks(store, commands);
  const ids = ['api','web'];
  for (const id of ids) {
    await writeFile(join(root,id,'check.cjs'),id === 'api' ? 'console.log("entry.ts(3,8): error TS2322: missing price");process.exit(1)' : '');
    store.putProfile(chat, commandProfile({id, name:id,directory:id,scope:[id,'shared'],commands:{types:'node check.cjs'}}));
  }
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=QA','-c','user.email=qa@example.org','commit','-qm','baseline'],{cwd:root});
  await writeFile(join(root,'shared','types.ts'),'export type Price = number');
  await writeFile(join(root,'notes.md'),'note');
  const current = store.chat(chat.id);
  const summary = () => checks.summary(current);
  const first = await summary();
  assert.deepEqual(first.uncovered,['notes.md']);
  assert.deepEqual(first.rows.map(row => row.reasons),[['shared/types.ts'],['shared/types.ts']]);
  await checks.run(current,ids);
  const failed = (await summary()).rows;
  assert.deepEqual(failed.map(row => row.status),['failed','completed']);
  assert.equal(failed[0].problem.path,'api/entry.ts'); assert.equal(failed[0].problem.line,3);
  await writeFile(join(root,'api','check.cjs'),'');
  await checks.run(current,ids);
  const passed = (await summary()).rows;
  assert.deepEqual(passed.map(row => row.status),['completed','completed']);
  assert.equal(passed[1].runId,failed[1].runId);
  await writeFile(join(root,'web','style.css'),'body{}');
  assert.deepEqual((await summary()).rows.map(row => row.status),['completed','stale']);
  assert.equal(store.chat(chat.id).profileId,'web');
});
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
    const result = store.command(run.id); assert.equal(result.exitCode, 7); assert.equal(result.status, 'failed'); assert.ok(result.output.includes('LAST') && result.output.includes('Проверка')); assert.equal(result.cwd, await realpath(folder));
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
