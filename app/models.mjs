import { createProvider, subscriptionMode, subscriptionModelIds } from './providers.mjs';

const modelCatalog = [
  ['qwen3.6-35b-a3b', 'Qwen3.6 35B', 262_144, 'Самая эффективная', 5.79],
  ['yandexgpt-5.1', 'YandexGPT Pro 5.1', 32_768, 'Быстрая альтернатива', 5.94],
  ['yandexgpt-5-pro', 'YandexGPT Pro 5', 32_768, 'Медиана до 10 с', 9.09],
  ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 1_048_576, 'Самый большой контекст', 12.07],
  ['aliceai-llm', 'Alice AI LLM', 131_072, 'Контекст 128K', 14.29],
  ['aliceai-llm-flash', 'Alice AI LLM Flash', 65_536, 'Самая дешёвая', 15.05],
];

export const models = modelCatalog.map(([id, label, context, badge, medianSeconds]) =>
  ({ id, label, context, badge, medianSeconds }));
export const lookupModel = id => models.find(model => model.id === id);
export const defaultModel = lookupModel('qwen3.6-35b-a3b');
export const legacyModel = lookupModel('aliceai-llm-flash');
const deepSeekV4 = { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', context: 1_000_000, badge: 'Подписка' };
export const subscriptionModels = subscriptionModelIds.map(id => lookupModel(id) ?? deepSeekV4);
export const modelsFor = mode => mode === subscriptionMode ? subscriptionModels : models;

export function availableModels(entries, folderId) {
  const prefix = `gpt://${folderId}/`;
  const ids = new Set(entries.filter(entry => typeof entry?.id === 'string' && entry.id.startsWith(prefix))
    .map(({ id }) => id.slice(prefix.length).replace(/\/latest$/, '')));
  return models.filter(model => ids.has(model.id));
}

export async function fetchModels(credentials) {
  const { folderId, mode } = credentials;
  if (mode === subscriptionMode) return subscriptionModels;
  const { response } = await createProvider(credentials).request('/models', {
    headers: { 'x-project': folderId },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Каталог Yandex AI Studio недоступен (HTTP ${response.status}).`);
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new Error('Яндекс вернул неожиданный ответ каталога.');
  return availableModels(data, folderId);
}
