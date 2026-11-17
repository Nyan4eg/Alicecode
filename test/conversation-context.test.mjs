import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../app/store.mjs';
import { inspectFragments, summarize, summaryPrompt } from '../app/conversation-context.mjs';
import { previewContext } from '../app/context.mjs';

test('compaction preserves complete history, model and workspace; pinned snapshots flag external changes after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-summary-')); let store;
  try {
    store = new Store(join(root, 'profile.sqlite')); const chat = store.addProject('Web', root);
    store.setModel(chat.id, 'qwen3.6-35b-a3b'); store.setTaskWorkspace(chat.id, { root, branch: 'alice/task', base: 'baseline' }); store.setSession(chat.id, 'old-session');
    await writeFile(join(root, 'code.ts'), 'export const value = 1;\n');
    const { content, ...ref } = await previewContext(root, 'code.ts'); store.savePins(chat.id, [ref]);
    const id = store.beginTurn(chat.id, 'Keep marker CONTINUE-V010'); store.saveTurn(id, { text: 'Tests 2/2 passed.', tools: [], status: 'done' });
    const before = store.snapshot().messages;
    const summary = store.saveSummary(chat.id, 'Goal: CONTINUE-V010; tests 2/2 passed.', id, root);
    assert.equal(store.chat(chat.id).sessionId, null); assert.equal(store.chat(chat.id).workspace.branch, 'alice/task');
    assert.deepEqual(store.snapshot().messages, before);
    await assert.rejects(async () => store.saveSummary(chat.id, 'overwrite', id, root, 'stale'));
    store.db.close(); store = new Store(join(root, 'profile.sqlite'));
    assert.equal(store.chat(chat.id).summary.id, summary.id); assert.equal(store.chat(chat.id).modelId, 'qwen3.6-35b-a3b');
    assert.equal((await inspectFragments(root, store.chat(chat.id).pins))[0].stale, false);
    await writeFile(join(root, 'code.ts'), 'export const value = 2;\n'); assert.equal((await inspectFragments(root, store.chat(chat.id).pins))[0].stale, true);
    assert.ok(summaryPrompt(store.chat(chat.id).summary).includes('CONTINUE-V010'));
    assert.deepEqual(store.snapshot().messages, before);
  } finally { store?.db.close(); await rm(root, { recursive: true, force: true }); }
});

test('a truncated model summary never replaces the current session', async () => {
  const provider = { request: async () => ({ response: Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), redact: text => text }) };
  await assert.rejects(summarize(provider, 'model', 'folder', [{ role: 'user', text: 'task' }], null, new AbortController().signal), /полную сводку/);
});
