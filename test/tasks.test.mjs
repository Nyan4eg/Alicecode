import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consent } from '../app/permissions.mjs';
import { projectInstructions, saveInstructions } from '../app/instructions.mjs';
import { finishStep, validatePlan, generatePlan } from '../app/task-plan.mjs';
import { Store } from '../app/store.mjs';

test('plan generation retries a truncated reasoning answer and rejects an incomplete plan', async () => {
  const budgets = [];
  const provider = { request: async (_path, options) => {
    budgets.push(JSON.parse(options.body).max_tokens);
    return { response: Response.json({ choices: [{ finish_reason: budgets.length === 1 ? 'length' : 'stop',
      message: { content: budgets.length === 1 ? '' : 'План:\n```json\n{"steps":[{"title":"Run tests","kind":"test"}]}\n```' } }] }), redact: text => text };
  } };
  const plan = await generatePlan(provider, 'model', 'folder', 'task', { text: '' }, new AbortController().signal);
  assert.deepEqual(budgets, [2500, 6000]); assert.equal(plan.steps[0].kind, 'test');
  provider.request = async () => ({ response: Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"steps":["partial"]}' } }] }), redact: text => text });
  await assert.rejects(generatePlan(provider, 'model', 'folder', 'task', { text: '' }, new AbortController().signal), /полный план/);
});

test('Bypass automatically approves every offered tool action without creating any approval queue', async () => {
  const turn = { mode: 'code', approval: 'bypass', permissions: [], stop: false };
  const journal = [];
  const hooks = { isActive: () => true, record: (...args) => journal.push(args), changed: () => assert.fail('Bypass opened an approval') };
  for (const kind of ['command', 'edit', 'managed-write', 'delete', 'git', 'unknown']) {
    assert.equal(await consent(turn, { kind, command: 'arbitrary command', id: kind }, allow => allow, hooks), true);
  }
  assert.equal(turn.permissions.length, 0); assert.equal(journal.length, 6);
  assert.ok(journal.every(item => item[1] === true && item[2] === true));
  turn.approval = 'ask'; let changed = false;
  const pending = consent(turn, { kind: 'command' }, allow => allow, { ...hooks, changed: () => { changed = true; } });
  assert.equal(changed, true); assert.equal(turn.permissions.length, 1);
  turn.permissions[0].resolvePermission(false); assert.equal(await pending, false);
});

test('instructions, task choices and interrupted steps persist; completing a test step requires actual success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-plan-'));
  let store;
  try {
    const initial = await projectInstructions(root); assert.equal(initial.exists, false);
    const snapshot = await saveInstructions(root, '# Rules\nUse node --test.\n', initial.stamp);
    await writeFile(join(root, 'AGENTS.md'), '# new rules\n');
    await assert.rejects(saveInstructions(root, 'old editor', snapshot.stamp), /изменился/);
    assert.equal(snapshot.text, '# Rules\nUse node --test.\n');
    const steps = validatePlan([{ title: 'Изучить код', kind: 'inspect' }, { title: 'Запустить тесты', kind: 'test' }]);
    assert.equal(finishStep(steps[1], []), false);
    assert.equal(finishStep(steps[1], [{ id: 'test', repeatable: true, exitCode: 1 }]), false);
    assert.equal(finishStep(steps[1], [{ id: 'test', repeatable: true, exitCode: 0 }]), true);
    assert.equal(finishStep(steps[0], [{ id: 'command', background: true, status: 'completed' }]), false);
    store = new Store(join(root, 'profile.sqlite')); const chat = store.addProject('Project', root);
    store.setTaskOptions(chat.id, { approval: 'bypass', planning: true });
    store.setDraftPlan(chat.id, { source: 'task', steps });
    const id = store.beginTurn(chat.id, 'task'); steps[0].status = 'running';
    store.saveTurn(id, { text: '', tools: [], status: 'running', task: { status: 'running', steps, instructions: snapshot, root } });
    store.db.close(); store = new Store(join(root, 'profile.sqlite'));
    assert.equal(store.chat(chat.id).approval, 'bypass'); assert.equal(store.chat(chat.id).planning, 1);
    const task = store.task(chat.id, id);
    assert.equal(task.status, 'stopped'); assert.equal(task.steps[0].status, 'stopped'); assert.equal(task.steps[1].status, 'done');
    assert.equal(task.instructions.text, snapshot.text);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# new rules\n');
  } finally { store?.db.close(); await rm(root, { recursive: true, force: true }); }
});
