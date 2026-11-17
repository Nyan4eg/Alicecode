import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { legacyModel } from './models.mjs';
import { createProvider, providerError } from './providers.mjs';

export const alias = 'alice-ai-llm-flash';
export const modelUri = (folderId, id = legacyModel.id) => `gpt://${folderId}/${id}`;

async function* normalizeToolIds(body) {
  const ids = new Map();
  const lines = createInterface({ input: Readable.fromWeb(body), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') {
      yield line + '\n';
      continue;
    }
    const chunk = JSON.parse(line.slice(6));
    // AI Studio can reuse a tool name as the call ID across turns.
    for (const choice of chunk.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        if (!call.id) continue;
        const position = `${choice.index}:${call.index}`;
        if (!ids.has(position)) ids.set(position, `call_${randomUUID().replaceAll('-', '')}`);
        call.id = ids.get(position);
      }
    }
    yield `data: ${JSON.stringify(chunk)}\n`;
  }
}

export async function startAdapter({ folderId, modelId = legacyModel.id, track = false, ...credentials }) {
  const provider = createProvider(credentials);
  const model = provider.model(folderId, modelId);
  const token = randomUUID();
  const requests = [];
  const tools = new Map();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
      || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end();
      return;
    }

    const disconnect = new AbortController();
    response.on('close', () => disconnect.abort());
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Grok uses a separate model name for session titles on the same endpoint.
      const title = body.tools?.some(tool => tool.function?.name === 'session_title') ?? false;
      if (track && !title) {
        for (const message of body.messages) {
          for (const call of message.tool_calls ?? []) {
            if (!tools.has(call.id)) {
              tools.set(call.id, { id: call.id, ...call.function });
            }
          }
          const tool = tools.get(message.tool_call_id);
          if (message.role === 'tool' && tool) tool.output = message.content;
        }
      }
      const observation = { title, stream: body.stream === true, status: null };
      if (track) requests.push(observation);
      const { response: upstream, redact } = await provider.request('/chat/completions', {
        method: 'POST',
        headers: {
          'OpenAI-Project': folderId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.any([AbortSignal.timeout(90_000), disconnect.signal]),
      });
      observation.status = upstream.status;
      if (!upstream.ok) {
        const detail = providerError(credentials.mode, upstream.status) ?? redact(await upstream.text()).slice(0, 1_000);
        if (!upstream.bodyUsed) await upstream.body?.cancel();
        console.error(`Yandex AI Studio HTTP ${upstream.status} ${detail}`);
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: detail } }));
        return;
      }
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      response.writeHead(upstream.status, { 'Content-Type': contentType });
      if (upstream.body) {
        const stream = contentType.includes('text/event-stream')
          ? normalizeToolIds(upstream.body)
          : upstream.body;
        await pipeline(stream, response);
      } else {
        response.end();
      }
    } catch (error) {
      if (disconnect.signal.aborted) return;
      console.error(`AI Studio request failed: ${error.message}`);
      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: error.name === 'ProviderAuthError' ? error.message : 'Запрос к Yandex не выполнен.' } }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, token, model, requests, tools, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
