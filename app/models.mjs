const modelCatalog = [
  ['aliceai-llm-flash', 'Alice AI LLM Flash', 65_536],
  ['aliceai-llm', 'Alice AI LLM', 131_072],
  ['yandexgpt-5.1', 'YandexGPT Pro 5.1', 32_768],
  ['yandexgpt-5-pro', 'YandexGPT Pro 5', 32_768],
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 1_048_576],
  ['qwen3.6-35b-a3b', 'Qwen3.6 35B', 262_144],
];

export const models = modelCatalog.map(([id, label, context]) => ({ id, label, context }));
export const defaultModel = models[0];
export const lookupModel = id => models.find(model => model.id === id);

export function availableModels(entries, folderId) {
  const prefix = `gpt://${folderId}/`;
  const ids = new Set(entries.filter(entry => typeof entry?.id === 'string' && entry.id.startsWith(prefix))
    .map(({ id }) => id.slice(prefix.length).replace(/\/latest$/, '')));
  return models.filter(model => ids.has(model.id));
}

export async function fetchModels({ folderId, apiKey }) {
  const response = await fetch('https://ai.api.cloud.yandex.net/v1/models', {
    headers: { Authorization: `Api-Key ${apiKey}`, 'x-project': folderId },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Каталог Yandex AI Studio недоступен (HTTP ${response.status}).`);
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new Error('Яндекс вернул неожиданный ответ каталога.');
  return availableModels(data, folderId);
}
