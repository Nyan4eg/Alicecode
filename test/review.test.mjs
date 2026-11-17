import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { finishReview, startReview } from '../app/review.mjs';
import { codeVersion, diffRange } from '../app/revision.mjs';
import { Store } from '../app/store.mjs';
import { listChanges, readProjectDiff } from '../app/workspace.mjs';

test('run diff compares against dirty working files without changing the Git index', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-run-review-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  const project = join(root, 'nested');
  await mkdir(project);
  const file = join(project, 'calculator.cjs');
  const base = 'const label = "original";\n' + '\n'.repeat(8) + 'function subtract(a,b) { return a + b; }\n';
  await writeFile(file, base);
  await writeFile(join(project, 'old.txt'), 'before\n');
  await writeFile(join(root, 'outside.txt'), 'outside\n');
  git('add', '.');
  git('-c', 'user.name=Alicecode', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Fixture');
  const staged = base.replace('original', 'staged');
  await writeFile(file, staged);
  git('add', 'nested/calculator.cjs');
  const initial = staged.replace('staged', 'working');
  await writeFile(file, initial);
  await writeFile(join(project, 'pre-existing.txt'), 'same\n');
  const index = await readFile(join(root, '.git', 'index'));
  const version = await codeVersion(project);
  assert.ok(version);
  const before = await startReview(project);

  await writeFile(file, initial.replace('a + b', 'a - b'));
  await writeFile(join(project, 'old.txt'), 'after\n');
  await writeFile(join(project, 'new.txt'), 'new\n');
  await writeFile(join(root, 'outside.txt'), 'edited outside project\n');
  const review = await finishReview(project, before);
  assert.notEqual(await codeVersion(project), version);
  assert.equal(review.state, 'ready');
  const patches = new Map(review.files.map(item => [item.path, item.patch]));
  assert.deepEqual([...patches.keys()], ['calculator.cjs', 'new.txt', 'old.txt']);
  assert.match(patches.get('calculator.cjs'), /-.*a \+ b;.*\n\+.*a - b;/);
  assert.doesNotMatch(patches.get('calculator.cjs'), /staged|working/);
  assert.match(patches.get('old.txt'), /-before\n\+after/);
  assert.match(patches.get('new.txt'), /\+new/);
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index);
  assert.match(await readProjectDiff(project, 'calculator.cjs', 'staged'), /\+.*staged/);
  assert.match(await readProjectDiff(project, 'calculator.cjs', 'unstaged'), /\+.*working/);
  assert.deepEqual((await listChanges(project)).find(item => item.path === 'calculator.cjs'),
    { path: 'calculator.cjs', staged: 'M', unstaged: 'M', untracked: false });

  const database = join(root, 'chat.sqlite');
  let store = new Store(database);
  const chat = store.addProject('Nested', project);
  const id = store.beginTurn(chat.id, 'Fix subtraction.', 'qwen3.6-35b-a3b',
    [{ path: 'calculator.cjs', start: 10, end: 10 }]);
  store.saveReview(id, review);
  const line = patches.get('calculator.cjs').split('\n').findIndex(line => line.startsWith('+'));
  store.addNote(chat.id, id, 'calculator.cjs', line, line, 'Keep the signed result');
  store.saveTurn(id, { text: 'Fixed.', status: 'done', tools: [] });
  store.db.close();
  store = new Store(database);
  try {
    const [user, assistant] = store.snapshot().messages;
    assert.deepEqual(user.attachments, [{ path: 'calculator.cjs', start: 10, end: 10 }]);
    assert.equal(assistant.review.files.length, 3);
    assert.equal(assistant.review.files[0].patch, undefined);
    assert.equal(store.reviewFile(chat.id, id, 'calculator.cjs').patch, patches.get('calculator.cjs'));
    assert.throws(() => store.reviewFile('other chat', id, 'calculator.cjs'), /не найдено/);
    const [note] = store.notes(chat.id);
    assert.match(note.anchor.snippet, /a - b/);
    const reply = store.beginTurn(chat.id, note.body, null, [], 'code', [note.id]);
    assert.equal(store.notes(chat.id)[0].reply, reply);
    assert.throws(() => store.beginTurn(chat.id, note.body, null, [], 'code', [note.id]), /изменились/);
    assert.equal(store.snapshot().messages.length, 4);
  } finally {
    store.db.close();
  }
});

test('review anchors retain old and new line coordinates and reject crossed hunks', () => {
  const patch = '@@ -42,2 +50,2 @@\n-old\n+new\n shared\n@@ -99 +99 @@\n-last\n+next';
  assert.equal(diffRange(patch, 1, 1).start, 42);
  assert.deepEqual(diffRange(patch, 2, 3), { start: 50, end: 51, side: 'new', snippet: 'new\nshared' });
  assert.throws(() => diffRange(patch, 1, 2));
  assert.throws(() => diffRange(patch, 3, 5));
});
