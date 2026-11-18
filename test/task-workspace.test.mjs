import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitIn } from '../app/workspace.mjs';
import { createTaskWorkspace, transferPreview, resolveTransfer, applyTransfer, taskWorkspaceDetails, removeTaskWorkspace } from '../app/task-workspace.mjs';
import { Store } from '../app/store.mjs';

test('a task branch includes staged and unstaged on-disk context, preserves the original index, and transfers only task edits with conflicts checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-task-'));
  let workspace;
  try {
    const repo = join(root, 'проект с пробелами'); await mkdir(repo);
    await gitIn(repo, ['init', '-q']);
    await gitIn(repo, ['config', 'user.name', 'QA']); await gitIn(repo, ['config', 'user.email', 'qa@example.test']);
    const source = Array.from({ length: 65 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const file = join(repo, 'code.js');
    await writeFile(file, source); await writeFile(join(repo, 'delete.txt'), 'delete me\n');
    await gitIn(repo, ['add', '.']); await gitIn(repo, ['commit', '-qm', 'base']);
    await writeFile(file, source.replace('line 3\n', 'staged user line\n'));
    await gitIn(repo, ['add', 'code.js']);
    const baseline = (await readFile(file, 'utf8')).replace('line 8\n', 'unstaged user line\n');
    await writeFile(file, baseline); await writeFile(join(repo, 'user.txt'), 'new user file\n');
    const status = await gitIn(repo, ['status', '--porcelain=v1', '-z']);
    const index = await readFile(join(repo, '.git', 'index'));
    workspace = await createTaskWorkspace(repo, join(root, 'tasks'), randomUUID(), 'alice/repair');
    assert.equal((await readFile(join(workspace.root, 'code.js'), 'utf8')).replace(/\r\n/g, '\n'), baseline);
    assert.equal((await readFile(join(workspace.root, 'user.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'new user file\n');
    assert.equal(await gitIn(repo, ['status', '--porcelain=v1', '-z']), status);
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index);
    assert.equal((await gitIn(workspace.root, ['branch', '--show-current'])).trim(), 'alice/repair');
    assert.deepEqual((await transferPreview(workspace)).files, []);
    const result = baseline.replace('line 35\n', 'agent fixed line\n');
    await writeFile(join(workspace.root, 'code.js'), result);
    await writeFile(join(workspace.root, 'created.txt'), 'agent new file\n');
    await unlink(join(workspace.root, 'delete.txt'));
    const concurrent = baseline.replace('line 55\n', 'later user line\n'); await writeFile(file, concurrent);
    const preview = await transferPreview(workspace);
    assert.equal(preview.conflict, false);
    assert.deepEqual(preview.files.map(file => file.path), ['code.js', 'created.txt', 'delete.txt']);
    await applyTransfer(workspace, preview.token);
    assert.equal(await readFile(file, 'utf8'), result.replace('line 55\n', 'later user line\n'));
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index);
    assert.equal(await readFile(join(repo, 'created.txt'), 'utf8'), 'agent new file\n');
    await assert.rejects(readFile(join(repo, 'delete.txt')));
    await writeFile(file, baseline.replace('line 35\n', 'conflicting user line\n'));
    const collision = await transferPreview(workspace);
    assert.equal(collision.conflict, true);
    await assert.rejects(applyTransfer(workspace, collision.token), /конфликт/);
    assert.ok((await readFile(file, 'utf8')).includes('conflicting user line'));
    await writeFile(file, concurrent);
    const stale = await transferPreview(workspace); await writeFile(file, concurrent + '// changed after preview\n');
    await assert.rejects(applyTransfer(workspace, stale.token), /изменились/);
  } finally {
    if (workspace) await gitIn(workspace.sourceRepo, ['worktree', 'remove', '--force', workspace.directory]);
    await rm(root, { recursive: true, force: true });
  }
});

test('an unborn Git repository can create a task branch without staging the original project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-unborn-'));
  let workspace;
  try {
    const repo = join(root, 'repo'); await mkdir(repo); await gitIn(repo, ['init', '-q']);
    await writeFile(join(repo, 'hello.js'), 'console.log("hello");\n');
    workspace = await createTaskWorkspace(repo, join(root, 'tasks'), randomUUID(), 'alice/first');
    assert.equal((await readFile(join(workspace.root, 'hello.js'), 'utf8')).replace(/\r\n/g, '\n'), 'console.log("hello");\n');
    assert.equal(await gitIn(repo, ['ls-files']), '');
    assert.equal(workspace.head, null);
  } finally {
    if (workspace) await gitIn(workspace.sourceRepo, ['worktree', 'remove', '--force', workspace.directory]);
    await rm(root, { recursive: true, force: true });
  }
});

test('nested task roots transfer empty files and refuse transfer after switching the original branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-nested-task-'));
  let workspace;
  try {
    const repo = join(root, 'repo'), source = join(repo, 'nested'); await mkdir(source, { recursive: true });
    await gitIn(repo, ['init', '-q']);
    await gitIn(repo, ['config', 'user.name', 'QA']); await gitIn(repo, ['config', 'user.email', 'qa@example.test']);
    await writeFile(join(source, 'code.js'), 'base\n'); await writeFile(join(repo, 'outside.txt'), 'outside\n');
    await gitIn(repo, ['add', '.']); await gitIn(repo, ['commit', '-qm', 'base']);
    await writeFile(join(repo, 'outside.txt'), 'user outside\n');
    workspace = await createTaskWorkspace(source, join(root, 'tasks'), randomUUID(), 'alice/nested');
    assert.equal(workspace.prefix, 'nested/');
    await writeFile(join(workspace.root, 'empty.txt'), '');
    const preview = await transferPreview(workspace);
    assert.equal(preview.conflict, false); assert.deepEqual(preview.files.map(file => file.path), ['empty.txt']);
    await applyTransfer(workspace, preview.token);
    assert.equal(await readFile(join(source, 'empty.txt'), 'utf8'), '');
    assert.equal(await readFile(join(repo, 'outside.txt'), 'utf8'), 'user outside\n');
    await gitIn(repo, ['switch', '-qc', 'other']);
    await assert.rejects(transferPreview(workspace), /другая ветка/);
  } finally {
    if (workspace) await gitIn(workspace.sourceRepo, ['worktree', 'remove', '--force', workspace.directory]);
    await rm(root, { recursive: true, force: true });
  }
});

test('manual conflict resolutions and selected transfers retain the index, refuse stale previews, and keep orphan branches manageable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-resolve-')), repo = join(root, 'repo'), home = join(root, 'tasks');
  let workspace, store;
  try {
    await mkdir(repo); await gitIn(repo, ['init', '-q']); await gitIn(repo, ['config', 'user.name', 'QA']); await gitIn(repo, ['config', 'user.email', 'qa@example.test']);
    await writeFile(join(repo, 'code.js'), 'const value = 1;\n'); await gitIn(repo, ['add', '.']); await gitIn(repo, ['commit', '-qm', 'base']);
    store = new Store(join(root, 'profile.sqlite')); const chat = store.addProject('Web', repo);
    workspace = await createTaskWorkspace(repo, home, chat.id, 'alice/resolve'); store.setTaskWorkspace(chat.id, workspace);
    await writeFile(join(workspace.root, 'code.js'), 'const value = 2;\n'); await writeFile(join(workspace.root, 'later.txt'), 'later\n');
    await writeFile(join(repo, 'code.js'), 'const value = 3;\n');
    const index = await readFile(join(repo, '.git', 'index')), preview = await transferPreview(workspace);
    assert.equal(preview.files.find(file => file.path === 'code.js').resolvable, true);
    assert.equal((await taskWorkspaceDetails(workspace, home)).removable, false);
    await assert.rejects(applyTransfer(workspace, preview.token, ['code.js'], { 'code.js': preview.files[0].conflict }), /маркеры/);
    const resolved = await resolveTransfer(preview, ['code.js'], { 'code.js': 'const value = 5; // combined\n' });
    assert.equal(resolved.length, 1);
    assert.match(resolved[0].patch, /-const value = 3;/);
    assert.match(resolved[0].patch, /\+const value = 5; \/\/ combined/);
    assert.deepEqual(await resolveTransfer(preview, ['code.js'], { 'code.js': 'const value = 3;\n' }), []);
    await applyTransfer(workspace, preview.token, ['code.js'], { 'code.js': resolved[0].text });
    assert.equal(await readFile(join(repo, 'code.js'), 'utf8'), 'const value = 5; // combined\n');
    await assert.rejects(readFile(join(repo, 'later.txt')));
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index);
    await assert.rejects(applyTransfer(workspace, preview.token, ['code.js'], { 'code.js': 'stale\n' }), /изменились/);
    const remaining = await transferPreview(workspace);
    await applyTransfer(workspace, remaining.token, ['later.txt']);
    workspace.transferred = Object.fromEntries(remaining.files.map(file => [file.path, file.desiredStamp]));
    store.saveTaskWorkspace(chat.id, chat.projectId, chat.id, workspace);
    store.deleteChat(chat.id); assert.equal(store.taskWorkspaces()[0].chatId, null);
    assert.equal((await taskWorkspaceDetails(workspace, home)).removable, true);
    const removed = await removeTaskWorkspace(workspace, home); workspace = null;
    store.saveTaskWorkspace(chat.id, chat.projectId, null, removed);
    assert.equal(store.taskWorkspaces()[0].state, 'removed');
    assert.ok((await gitIn(repo, ['branch', '--list', 'alice/resolve'])).includes('alice/resolve'));
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), index);
  } finally {
    if (workspace) await gitIn(repo, ['worktree', 'remove', '--force', workspace.directory]);
    store?.db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('a restarted transfer retains the original diff and completed checks and allows interrupted checks to retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-card-'));
  const db = join(root, 'profile.sqlite');
  let store = new Store(db);
  try {
    const chat = store.addProject('Packages', root);
    const card = { id: randomUUID(), chatId: chat.id, root, running: true, files: ['shared/types.ts'],
      checks: [{ id: 'api', status: 'completed', runId: 'api-run' }, { id: 'web', status: 'in_progress' }] };
    const patches = [{ path: 'shared/types.ts', patch: '+export interface Quote {}' }];
    store.addTransfer(card, patches);
    store.db.close(); store = new Store(db);
    const [saved] = store.transfers(chat.id);
    assert.equal(saved.running, false);
    assert.deepEqual(saved.checks, [card.checks[0], { id: 'web', status: 'interrupted' }]);
    assert.deepEqual(store.transferPatches(chat.id, card.id), patches);
    store.deleteChat(chat.id);
    assert.deepEqual(store.transfers(chat.id), []);
  } finally { store.db.close(); await rm(root, { recursive: true, force: true }); }
});
