import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../app/store.mjs';
import { Attachments } from '../app/attachments.mjs';
import { searchContent } from '../app/workspace.mjs';

test('draft text, context, dirty editor buffers, view and external snapshots survive reopening and deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-state-'));
  let store;
  try {
    const path = join(root, 'profile.sqlite');
    store = new Store(path);
    const chat = store.addProject('One', root);
    const composer = { draft: 'Продолжить завтра', context: [{ path: 'src/app.js', start: 2, end: 4, digest: 'abc' }],
      view: { tab: 'changes', scrollTop: 165, atBottom: false, editorPath: 'src/app.js' } };
    const project = { files: [{ path: 'src/app.js', text: 'unsaved', cleanText: 'original', stamp: 'old', dirty: true,
      selection: { anchor: 3, head: 3 }, scrollTop: 50 }] };
    store.saveWorkspace('chat', chat.id, composer);
    store.saveWorkspace('project', chat.projectId, project);
    store.setMode(chat.id, 'discuss');
    await writeFile(join(root, 'ТЗ.md'), 'original reference');
    const attachments = await Attachments.open(join(root, 'context-files'));
    attachments.persistDraft = (id, files) => store.saveDraftFiles(id, files);
    const choice = await attachments.choose(chat.id, [join(root, 'ТЗ.md')]);
    const [file] = await attachments.attach(chat.id, choice.key, [choice.items[0].id]);
    await writeFile(join(root, 'ТЗ.md'), 'changed original');
    store.db.close(); store = new Store(path);
    assert.deepEqual(store.workspaceStates('chat')[chat.id], composer);
    assert.deepEqual(store.workspaceStates('project')[chat.projectId], project);
    assert.equal(store.chat(chat.id).mode, 'discuss');
    const reopened = await Attachments.open(join(root, 'context-files'));
    reopened.drafts = new Map(store.draftFiles().map(([id, files]) => [id, new Map(files.map(file => [file.id, file]))]));
    reopened.persistDraft = (id, files) => store.saveDraftFiles(id, files);
    const files = reopened.files(chat.id, [file.id]);
    assert.equal(files[0].text, 'original reference');
    await reopened.save(chat.id, files);
    assert.equal(await reopened.read(chat.id, files, reopened.path(chat.id, files[0])), 'original reference');
    assert.deepEqual(store.draftFiles(), []);
    store.deleteChat(chat.id);
    assert.deepEqual(store.workspaceStates('chat'), {});
  } finally { store?.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('content search is literal, bounded, uses Git ignores, and does not follow links outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-search-'));
  try {
    const project = join(root, 'project'); await mkdir(project);
    execFileSync('git', ['init', '-q', project], { windowsHide: true });
    await writeFile(join(project, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(project, 'code.js'), 'line1\nconst price = "[ABC]";\nconsole.log(price);\n');
    await writeFile(join(project, 'ignored.txt'), '[ABC]');
    await writeFile(join(project, 'binary.dat'), '\0[ABC]');
    await mkdir(join(root, 'external')); await writeFile(join(root, 'external', 'secret.txt'), '[ABC]');
    await symlink(join(root, 'external'), join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await searchContent(project, '[abc]');
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0], { path: 'code.js', line: 2, column: 16, totalLines: 3, snippet: 'const price = "[ABC]";' });
    assert.equal(result.skipped, 2); // binary and Git's link entry
    await writeFile(join(project, 'many.txt'), 'needle\n'.repeat(200));
    const capped = await searchContent(project, 'needle');
    assert.equal(capped.matches.length, 150); assert.equal(capped.limited, true);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(searchContent(project, 'needle', { signal: abort.signal }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
