import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function usageCounts(usage) {
  if (!usage || !Number.isSafeInteger(usage.total_tokens)) return null;
  return { input: usage.prompt_tokens ?? null, output: usage.completion_tokens ?? null, total: usage.total_tokens };
}
export async function completeRequest(provider, path, options, observe = () => {}, { waits = [700, 1800], maxBytes = 8_000_000 } = {}) {
  const id = randomUUID(), startedAt = Date.now();
  let body; try { body = JSON.parse(options.body); } catch {}
  const base = { id, startedAt, inputChars: JSON.stringify(body?.messages ?? []).length, model: body?.model };
  const event = value => observe({ ...base, elapsedMs: Date.now() - startedAt, ...value });
  let last;
  for (let attempt = 1; attempt <= waits.length + 1; attempt++) {
    options.signal?.throwIfAborted(); event({ phase: 'waiting', attempt, maxAttempts: waits.length + 1 });
    let retryAfter = 0;
    try {
      const result = await provider.request(path, options);
      const upstream = result.response;
      if (!upstream.ok) {
        if (![408, 429, 500, 502, 503, 504].includes(upstream.status) || attempt > waits.length) {
          event({ phase: 'error', attempt, status: upstream.status, reason: 'HTTP ' + upstream.status }); return result;
        }
        const header = upstream.headers.get('retry-after');
        retryAfter = header && /^\d+$/.test(header) ? Math.min(10000, Number(header) * 1000) : 0;
        await upstream.body?.cancel(); throw new Error('HTTP ' + upstream.status);
      }
      const reader = upstream.body?.getReader(); const parts = []; let size = 0;
      event({ phase: 'receiving', attempt });
      if (reader) try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { const error = new Error('Ответ модели слишком большой.'); error.noRetry = true; throw error; }
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = Buffer.concat(parts), text = bytes.toString('utf8');
      const streaming = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
      let usage = null;
      if (streaming) {
        let done = false;
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') { done = true; continue; } if (!data) continue;
          const chunk = JSON.parse(data); usage = usageCounts(chunk.usage) ?? usage;
        }
        if (!done) throw new Error('Поток ответа оборвался до завершения.');
      } else { usage = usageCounts(JSON.parse(text).usage); }
      event({ phase: 'done', attempt, status: upstream.status, usage, outputChars: text.length });
      // Nothing, including a partial tool call, reaches the agent before the response is complete.
      return { ...result, response: new Response(bytes, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } }) };
    } catch (error) {
      if (options.signal?.aborted) { event({ phase: 'cancelled', attempt, reason: options.signal.reason?.name === 'TimeoutError' ? 'Истекло время ожидания запроса.' : 'Запрос остановлен.' }); options.signal.throwIfAborted(); }
      last = error;
      if (error.noRetry || attempt > waits.length) { event({ phase: 'error', attempt, reason: error.message }); throw error; }
      const waitMs = Math.max(retryAfter, waits[attempt - 1]);
      event({ phase: 'retry', attempt, waitMs, reason: error.message });
      await delay(waitMs, undefined, { signal: options.signal }).catch(error => { event({ phase: 'cancelled', attempt, reason: 'Запрос остановлен.' }); throw error; });
    }
  }
  throw last;
}
export function monitoredProvider(provider, observe) {
  return { model: provider.model.bind(provider), request: (path, options) => completeRequest(provider, path, options, observe) };
}
