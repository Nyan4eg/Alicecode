import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLayout } from '../app/layout.mjs';
import { availableModels } from '../app/models.mjs';
import { Store } from '../app/store.mjs';

test('rename preserves the workspace, session, and a title chosen before the first message', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const first = store.addProject('Калькулятор', 'C:/work/calculator');
  store.renameProject(first.projectId, '  Инструменты   расчёта ');
  store.renameChat(first.id, '  Сложение и вычитание  ');
  store.setSession(first.id, 'session-01');
  store.beginTurn(first.id, 'Проверь вычисления.');
  assert.equal(store.chat(first.id).title, 'Сложение и вычитание');
  assert.equal(store.chat(first.id).projectTitle, 'Инструменты расчёта');
  assert.equal(store.chat(first.id).cwd, 'C:/work/calculator');
  assert.equal(store.chat(first.id).sessionId, 'session-01');
});

test('project navigation remembers the last chat and search finds titles and messages across projects', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const design = store.addProject('Проект вёрстки', 'C:/work/design');
  const review = store.addChat(design.projectId);
  store.renameChat(review.id, 'Вёрстка формы');
  const message = store.beginTurn(review.id, 'Проверка\nверстки, редкая фраза.');
  store.saveTurn(message, { text: 'Готово, добавил кнопку.', status: 'done', tools: [] });
  const other = store.addProject('Другой проект', 'C:/work/other');
  assert.equal(store.selectProject(design.projectId).id, review.id);
  assert.equal(store.selectProject(other.projectId).id, other.id);
  assert.deepEqual(store.search('ВЕРСТК').map(result => result.kind), ['project', 'chat', 'message']);
  const hit = store.search('проверка вёрстки')[0];
  assert.equal(hit.chatId, review.id);
  assert.ok(hit.messageId);
  assert.equal(store.search('ДОБАВИЛ КНОПКУ')[0].messageId, message);
  assert.equal(store.search('%').length, 0);
});

test('a chat model and the model of each answer are independent', t => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const chat = store.addProject('Калькулятор', 'C:/work/calculator');
  const answer = store.beginTurn(chat.id, 'Привет', 'aliceai-llm-flash');
  store.setModel(chat.id, 'deepseek-v4.1-flash');
  assert.equal(store.chat(chat.id).modelId, 'deepseek-v4.1-flash');
  assert.equal(store.snapshot().messages.find(item => item.id === answer).modelId, 'aliceai-llm-flash');
});

test('catalog only lists verified text models available to the current folder', () => {
  const entries = [
    { id: 'gpt://folder/aliceai-llm-flash/latest' },
    { id: 'gpt://folder/aliceai-llm-flash' },
    { id: 'gpt://folder/yandexgpt-5-pro/latest' },
    { id: 'gpt://folder/unknown-tuned-model/latest' },
    { id: 'gpt://folder/speech-realtime-max-tts-live/latest' },
    { id: 'emb://folder/text-embeddings/latest' },
    { id: 'gpt://another/deepseek-v4.1-flash/latest' },
    { id: 'gpt://folder/qwen3.6-35b-a3b/latest' },
  ];
  assert.deepEqual(availableModels(entries, 'folder').map(model => model.id),
    ['aliceai-llm-flash', 'yandexgpt-5-pro', 'qwen3.6-35b-a3b']);
});

test('layout preferences clamp invalid widths and persist inspector visibility', () => {
  assert.deepEqual(normalizeLayout({ sidebar: 10, inspector: 900, inspectorVisible: false }),
    { sidebar: 150, inspector: 720, inspectorVisible: false });
  assert.deepEqual(normalizeLayout({ sidebar: Infinity, inspector: null }),
    { sidebar: null, inspector: null, inspectorVisible: true });
});
