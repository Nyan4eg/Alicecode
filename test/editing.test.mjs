import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import test from 'node:test';
import { agentTextForDisk, editableFile, planRollback, textForDisk, writeChecked } from '../app/editing.mjs';
import { commitPreview, createCommit, gitHunks, stageFile, stageHunks } from '../app/git.mjs';

async function repo(t) {
  const path = await mkdtemp(join(tmpdir(), 'alicecode-v05-'));
  assert.equal(dirname(resolve(path)), resolve(tmpdir()));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  for (const [key, value] of Object.entries({ 'core.autocrlf': 'false', 'user.email': 'qa@example.invalid',
    'user.name': 'Alicecode QA', 'commit.gpgsign': 'false', 'core.hooksPath': '.no-hooks' })) git('config', key, value);
  return { path, git };
}

test('inverse writes preserve staged and interleaved edits and refuse an overlap', async t => {
  const { path, git } = await repo(t);
  const full = join(path, 'calc.js');
  const base = 'title=base\n' + '\n'.repeat(8) + 'subtract=a+b\n' + '\n'.repeat(8) + 'manual=base\n';
  await writeFile(full, base);
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const staged = base.replace('title=base', 'title=staged');
  await writeFile(full, staged);
  git('add', '--', 'calc.js');
  const index = await readFile(join(path, '.git', 'index'));
  const before = staged.replace('title=staged', 'title=unstaged');
  await writeFile(full, before);
  const after = before.replace('subtract=a+b', 'subtract=a-b');
  await writeChecked(path, await editableFile(path, toNamespacedPath(full)), after);
  const edits = [{ id: 1, beforeText: before, afterText: after }];
  const conflict = after.replace('subtract=a-b', 'subtract=custom');
  await writeFile(full, conflict);
  const flagged = await planRollback(path, 'calc.js', edits);
  assert.match(flagged.conflict, /<<<<<<< Текущий файл/);
  assert.equal(await readFile(full, 'utf8'), conflict);
  const interleaved = after.replace('manual=base', 'manual=later');
  const last = interleaved.replace('subtract=a-b', 'subtract=b-a');
  await writeFile(full, last);
  const same = await planRollback(path, 'calc.js', [{ id: 2, beforeText: interleaved, afterText: last }, ...edits]);
  assert.equal(same.text, before.replace('manual=base', 'manual=later'));
  await writeChecked(path, same.file, same.text);
  assert.equal(await readFile(full, 'utf8'), same.text);
  assert.deepEqual(await readFile(join(path, '.git', 'index')), index);
  await assert.rejects(writeChecked(path, same.file, after), /Файл изменился/);
  assert.equal(textForDisk('\uFEFFone\r\ntwo\nthree\r\n', 'one\nchanged\nthree\n'), '\uFEFFone\r\nchanged\nthree\r\n');
  assert.equal(agentTextForDisk('\uFEFFone\r\ntwo\r\n', 'one\nchanged'), '\uFEFFone\r\nchanged\r\n');
});

test('stage chosen text hunks and commit the reviewed index across the full repository', async t => {
  const { path, git } = await repo(t);
  const name = 'parts.js';
  const file = join(path, name);
  const initial = Array.from({ length: 21 }, (_, i) => 'line ' + i).join('\n') + '\n';
  await writeFile(file, initial);
  await writeFile(join(path, 'other.js'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  await writeFile(file, initial.replace('line 0\n', 'chosen\n').replace('line 20\n', 'other hunk\n'));
  await writeFile(join(path, 'other.js'), 'external staged\n');
  git('add', '--', 'other.js');
  const preview = await gitHunks(path, name, 'unstaged');
  assert.equal(preview.hunks.length, 2);
  await stageHunks(path, name, 'unstaged', [0], preview.token);
  assert.match(git('show', ':parts.js'), /chosen/);
  assert.doesNotMatch(git('show', ':parts.js'), /other hunk/);
  const reverse = await gitHunks(path, name, 'staged');
  await stageHunks(path, name, 'staged', [0], reverse.token);
  assert.equal(git('show', ':parts.js'), initial);
  await stageFile(path, name, true);
  const commit = await commitPreview(path);
  assert.deepEqual(commit.paths, ['other.js', 'parts.js']);
  assert.match(commit.diff, /external staged/);
  await stageFile(path, name, false);
  await assert.rejects(createCommit(path, commit.token, 'stale'), /индекс изменились/);
  const next = await commitPreview(path);
  const hash = await createCommit(path, next.token, 'Reviewed index');
  assert.equal(hash, git('rev-parse', '--short', 'HEAD').trim());
  assert.equal(git('show', 'HEAD:parts.js'), initial);
  assert.match(await readFile(file, 'utf8'), /other hunk/);
});
