import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { listChanges, readProjectDiff } from '../app/workspace.mjs';

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
    { path: 'calculator.cjs', status: 'M' }, { path: 'ещё тест.cjs', status: '?' },
  ].sort((a, b) => a.path.localeCompare(b.path)));
  assert.match(await readProjectDiff(project, 'calculator.cjs'), /-return a \+ b;\r?\n\+return a - b;/);
  assert.match(await readProjectDiff(project, 'ещё тест.cjs'), /\+test\(\);/);
  await assert.rejects(readProjectDiff(project, '../outside.cjs'), /вне проекта/);
});
