import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvider, providerError, validateSubscription } from '../app/providers.mjs';
import { defaultModel, fetchModels, modelsFor } from '../app/models.mjs';

test('subscription and API-key requests use separate endpoints and authorization', async () => {
  const seen = [];
  const send = async (url, request) => { seen.push({ url, request }); return new Response('rate limited', { status: 429 }); };
  const iamToken = 'example-manual-token-000000';
  const config = validateSubscription({ folderId: 'folder', tokenSource: 'manual', iamToken });
  const provider = createProvider(config, { send });
  assert.equal(provider.model('folder', defaultModel.id), 'gpt://folder/qwen3.6-35b-a3b/latest');
  const result = await provider.request('/chat/completions', { method: 'POST', headers: { 'OpenAI-Project': 'folder' } });
  assert.equal(result.response.status, 429);
  assert.equal(result.redact(iamToken), '[redacted]');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://apps.ai.api.cloud.yandex.net/v1/chat/completions');
  assert.equal(seen[0].request.headers.Authorization, 'Bearer ' + iamToken);
  assert.equal(seen[0].request.redirect, 'error');
  assert.match(providerError('subscription', 429), /выбрать вручную/);
  assert.deepEqual(await fetchModels(config), modelsFor('subscription'));
  assert.ok(modelsFor('subscription').some(model => model.id === defaultModel.id));
  const key = createProvider({ folderId: 'other', apiKey: 'example-key' }, { send });
  assert.equal(key.model('other', defaultModel.id), 'gpt://other/qwen3.6-35b-a3b');
  await key.request('/chat/completions', { method: 'POST' });
  assert.equal(seen[1].url, 'https://ai.api.cloud.yandex.net/v1/chat/completions');
  assert.equal(seen[1].request.headers.Authorization, 'Api-Key example-key');
});

test('CLI mode renews a rejected token once and stays on the subscription endpoint', async () => {
  const config = validateSubscription({ folderId: 'folder', tokenSource: 'cli', cliProfile: 'billing' });
  let issued = 0;
  const requests = [];
  const provider = createProvider(config, {
    readToken: async profile => { assert.equal(profile, 'billing'); return 'token' + ++issued; },
    send: async (url, options) => {
      requests.push(options.headers.Authorization);
      assert.equal(url, 'https://apps.ai.api.cloud.yandex.net/v1/chat/completions');
      return new Response('{}', { status: requests.length === 1 ? 401 : 200 });
    },
  });
  assert.equal((await provider.request('/chat/completions', {})).response.status, 200);
  assert.equal((await provider.request('/chat/completions', {})).response.status, 200);
  assert.deepEqual(requests, ['Bearer token1', 'Bearer token2', 'Bearer token2']);
});
