import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { listChanges, listDirectory, readProjectDiff, searchFiles } from '../app/workspace.mjs';
import { previewContext, resolveContext } from '../app/context.mjs';

test('a nested project lists and displays individual tracked and new files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-diff-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'sub');
  await mkdir(project);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  await Promise.all([
    writeFile(join(project, 'calculator.cjs'), 'return a + b;\n'),
    writeFile(join(root, 'outside.cjs'), 'original\n'),
  ]);
  git('add', '.');
  git('-c', 'user.name=Alicecode', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-qm', 'Baseline');
  await Promise.all([
    writeFile(join(project, 'calculator.cjs'), 'return a - b;\n'),
    writeFile(join(project, 'ещё тест.cjs'), 'test();\n'),
    writeFile(join(root, 'outside.cjs'), 'changed\n'),
  ]);
  assert.deepEqual(await listChanges(project), [
    { path: 'calculator.cjs', staged: null, unstaged: 'M', untracked: false },
    { path: 'ещё тест.cjs', staged: null, unstaged: null, untracked: true },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.match(await readProjectDiff(project, 'calculator.cjs'), /-return a \+ b;\r?\n\+return a - b;/);
  assert.match(await readProjectDiff(project, 'ещё тест.cjs'), /\+test\(\);/);
  await assert.rejects(readProjectDiff(project, '../outside.cjs'), /вне проекта/);
});

test('file discovery and context use the selected project and respect ignored paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-files-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const relativePath = 'backend/a/b/c/d/e/f/g/сумма.js';
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), 'first\r\nsecond\r\nthird\r\n');
  await mkdir(join(root, 'generated'));
  await writeFile(join(root, '.gitignore'), 'generated/\n');
  await writeFile(join(root, 'generated', 'hidden.js'), '');
  assert.deepEqual(await searchFiles(root, 'backend сумма'), [relativePath]);
  assert.deepEqual(await searchFiles(root, 'hidden.js'), []);
  assert.ok(!(await listDirectory(root)).some(item => item.path === 'generated'));
  assert.equal((await listDirectory(root, 'backend/a/b/c/d/e/f/g'))[0].path, relativePath);
  const snippet = await previewContext(root, relativePath, 2, 2);
  assert.equal(snippet.content, 'second');
  assert.deepEqual(await resolveContext(root, [snippet]), [snippet]);
  await assert.rejects(previewContext(root, '../outside.js', 2, 2), /вне проекта/);
  await writeFile(join(root, relativePath), 'first\nchanged\nthird\n');
  await assert.rejects(resolveContext(root, [snippet]), /Файл изменился/);
});
