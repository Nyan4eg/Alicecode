import test from 'node:test';
import assert from 'node:assert/strict';
import { completeRequest } from '../app/requests.mjs';

test('an interrupted stream is retried before any tool call is forwarded; usage and abort are recorded', async () => {
  let calls = 0; const events = [];
  const provider = { request: async () => {
    calls++;
    const chunk = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"once","function":{"name":"command"}}]}}]}\n\n';
    const body = calls === 1 ? new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); controller.error(new Error('connection reset')); } }) : chunk + 'data: {"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13},"choices":[]}\n\ndata: [DONE]\n\n';
    return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), redact: value => value };
  } };
  const result = await completeRequest(provider, '/chat/completions', { body: '{"messages":[]}' }, event => events.push(event), { waits: [1] });
  assert.equal(calls, 2); assert.equal((await result.response.text()).match(/"id":"once"/g).length, 1);
  assert.equal(events.filter(event => event.phase === 'retry').length, 1); assert.equal(events.at(-1).usage.total, 13);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(completeRequest(provider, '/chat/completions', { signal: controller.signal })); assert.equal(calls, 2);
});

test('transient HTTP failures retry but authentication failures do not', async () => {
  let calls = 0;
  const provider = { request: async () => ({ response: ++calls < 3 ? new Response('', { status: 503 }) : Response.json({ choices: [{ message: { content: 'ok' } }] }) }) };
  await completeRequest(provider, '/chat/completions', {}, () => {}, { waits: [1, 1] }); assert.equal(calls, 3);
  calls = 0; provider.request = async () => { calls++; return { response: new Response('', { status: 401 }) }; };
  assert.equal((await completeRequest(provider, '/chat/completions', {})).response.status, 401); assert.equal(calls, 1);
});

test('cancelling during retry backoff stops the next request and clears the waiting state', async () => {
  const controller = new AbortController(), events = []; let calls = 0;
  const provider = { request: async () => { calls++; return { response: new Response('', { status: 503 }) }; } };
  await assert.rejects(completeRequest(provider, '/chat/completions', { signal: controller.signal }, event => {
    events.push(event); if (event.phase === 'retry') controller.abort();
  }, { waits: [5000] }));
  assert.equal(calls, 1); assert.equal(events.at(-1).phase, 'cancelled');
});
