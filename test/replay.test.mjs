import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { nodeTestCounts } from '../app/activity.mjs';
import { replayDetails, runTest, testInvocation } from '../app/replay.mjs';

test('replay uses a recorded test command and runs in the same project directory', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'alicecode-test-replay-'));
  assert.equal(dirname(resolve(cwd)), resolve(tmpdir()));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const command = 'node --test "suite with spaces.cjs"';
  await writeFile(join(cwd, 'suite with spaces.cjs'), "require('node:test')('sample', () => {});\n");
  const details = await replayDetails(cwd, { kind: 'execute', command, cwd, exitCode: 1 });
  assert.deepEqual(details?.invocation, { file: 'node', args: ['--test', 'suite with spaces.cjs'] });
  const result = await runTest(details, new AbortController().signal);
  assert.equal(result.exitCode, 0, result.error);
  assert.deepEqual(nodeTestCounts(result.output), { passed: 1, failed: 0, total: 1 });
  assert.ok(result.elapsedMs > 0);
  assert.equal(testInvocation('npm test && echo second'), null);
  assert.equal(testInvocation('node --test *.test.cjs'), null);
  assert.equal(await replayDetails(cwd, { kind: 'execute', command, cwd: dirname(cwd), exitCode: 0 }), null);
  assert.equal(await replayDetails(cwd, { kind: 'execute', command, exitCode: 0 }), null);
});
