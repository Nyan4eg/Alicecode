import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { describePermission, mergeToolUpdate } from '../app/activity.mjs';

const root = resolve('demo');
const update = (status, body) => ({ toolCallId: 'tool', status, ...body });

test('streaming Bash updates and completed nonzero exits are distinguished', () => {
  const started = mergeToolUpdate({}, update('pending', {
    kind: 'execute', rawInput: { command: 'node --test' },
  }), root);
  const running = mergeToolUpdate(started, update('in_progress', {
    rawOutput: { exit_code: 0 },
  }), root);
  assert.equal(running.exitCode, undefined);
  const failed = mergeToolUpdate(running, update('completed', {
    rawOutput: { exit_code: 1 },
    content: [{
      type: 'content',
      content: { type: 'text', text: '\x1b[34mℹ tests 3\x1b[0m\nℹ pass 2\nℹ fail 1' },
    }],
  }), root);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.command, 'node --test');
  assert.deepEqual(failed.tests, { total: 3, passed: 2, failed: 1 });
  assert.ok(!failed.output.includes('\x1b'));
});

test('TAP counts are retained for a successful run', () => {
  const tool = mergeToolUpdate({}, update('completed', {
    rawOutput: { command: 'node --test --test-reporter=tap', exit_code: 0,
      output_for_prompt: 'TAP version 13\n# tests 3\n# pass 3\n# fail 0\n' },
  }), root);
  assert.equal(tool.exitCode, 0);
  assert.deepEqual(tool.tests, { total: 3, passed: 3, failed: 0 });
});

test('edit paths and permission previews use the ACP fields', () => {
  const edit = { path: join(root, 'calculator.cjs'), oldText: 'return a + b;', newText: 'return a - b;' };
  const payload = update('pending', {
    kind: 'edit', content: [{ type: 'diff', ...edit }],
    locations: [{ path: join(root, '..', 'outside.cjs') }],
  });
  assert.deepEqual(mergeToolUpdate({}, payload, root).paths, ['calculator.cjs']);
  assert.deepEqual(describePermission(payload, root).changes,
    [{ path: edit.path, before: edit.oldText, after: edit.newText }]);
  assert.equal(describePermission({ kind: 'execute', rawInput: { command: 'node --test' } },
    root, join(root, 'sub')).directory, join(root, 'sub'));
});
