import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { AcpClient, startRuntime } from './acp.mjs';
import { alias } from './adapter.mjs';
import { readPrototypeCredentials, validateCredentials } from './credentials.mjs';
import { createProject, listChanges, listFiles, readProjectDiff, readProjectFile } from './workspace.mjs';
import { createUpdates } from './updates.mjs';
import { describePermission, mergeToolUpdate } from './activity.mjs';
import { defaultModel, fetchModels, legacyModel, lookupModel, models } from './models.mjs';
import { normalizeLayout } from './layout.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const cancelledPermission = () => ({ outcome: { outcome: 'cancelled' } });
app.setName('Alicecode');
app.setAppUserModelId('io.github.nyan4eg.alicecode');
const devProfile = !app.isPackaged && app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', devProfile || join(app.getPath('appData'), 'Alicecode'));
let window;
let store;
let credentials;
let credentialError;
let runtime;
let active;
let available = models;
let catalogStatus = 'loading';
const updates = createUpdates(state => emit('app:update', state));

function snapshot() {
  return {
    ...store.snapshot(), configured: Boolean(credentials), credentialError,
    busy: active?.chatId ?? null, permission: active?.permissions[0]?.details ?? null,
    updates: updates.snapshot(),
    models: available, defaultModel: defaultModel.id, catalogStatus,
    layout: normalizeLayout(JSON.parse(store.setting('layout') ?? '{}')),
    projectRoot: store.setting('projectRoot') ?? join(app.getPath('documents'), 'Alicecode Projects'),
  };
}

function emit(event, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(event, payload);
}

function closeRuntime() {
  runtime?.dispose();
  runtime = undefined;
}

async function saveCredentials(value) {
  const next = validateCredentials(value);
  const bytes = await safeStorage.encryptStringAsync(JSON.stringify(next));
  store.set('credentials', bytes.toString('base64'));
  closeRuntime();
  credentials = next;
  credentialError = null;
  available = models;
  catalogStatus = 'loading';
}

async function refreshModels() {
  const source = credentials;
  if (!source) return;
  catalogStatus = 'loading';
  emit('app:catalog', { models: available, catalogStatus });
  try {
    const result = await fetchModels(source);
    if (credentials !== source) return;
    available = result;
    catalogStatus = 'ready';
  } catch {
    if (credentials !== source) return;
    catalogStatus = 'error';
  }
  emit('app:catalog', { models: available, catalogStatus });
}

async function importCredentials() {
  const saved = store.setting('credentials');
  if (saved) {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(saved, 'base64'));
    credentials = validateCredentials(JSON.parse(result));
  } else if (!devProfile) {
    const value = await readPrototypeCredentials();
    if (value) await saveCredentials(value);
  }
}

function updateTurn(turn, { sessionId, update }) {
  if (turn.sessionId !== sessionId || turn.stop) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    turn.message.text += update.content.text;
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const prior = turn.tools.get(update.toolCallId) ?? {};
    turn.tools.set(update.toolCallId, mergeToolUpdate(prior, update, turn.cwd));
    if (update.status === 'completed' && typeof update.rawOutput?.current_dir === 'string') {
      turn.shellCwd = update.rawOutput.current_dir;
    }
  } else {
    return;
  }
  if (turn.refresh) return;
  turn.refresh = setTimeout(() => {
    turn.refresh = undefined;
    publishTurn(turn);
  }, 80);
}

function publishTurn(turn) {
  turn.message.tools = [...turn.tools.values()];
  store.saveTurn(turn.message.id, turn.message);
  emit('chat:message', turn.message);
}

function requestPermission(turn, params) {
  if (turn.stop || active !== turn) return cancelledPermission();
  const permit = params.options.find(option => option.kind === 'allow_once');
  if (!permit) return cancelledPermission();
  const reject = params.options.find(option => option.kind === 'reject_once');
  return new Promise(resolvePermission => {
    const details = {
      id: params.toolCall.toolCallId,
      chatId: turn.chatId,
      ...describePermission(params.toolCall, turn.cwd, turn.shellCwd),
    };
    turn.permissions.push({ details, permit: permit.optionId, reject: reject?.optionId, resolvePermission });
    emit('app:state', snapshot());
  });
}

function resolvePermission(id, allow) {
  const p = active?.permissions[0];
  if (!p || p.details.id !== id) return;
  active.permissions.shift();
  const tool = active.tools.get(id) ?? { id, title: p.details.title };
  active.tools.set(id, { ...tool, decision: allow ? 'allowed' : 'denied' });
  publishTurn(active);
  const optionId = allow ? p.permit : p.reject;
  p.resolvePermission(optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission());
  emit('app:state', snapshot());
}

function cancelPermissions(turn) {
  for (const pending of turn.permissions.splice(0)) pending.resolvePermission(cancelledPermission());
}

async function send(chatId, input) {
  if (active) throw new Error('Дождитесь завершения текущей задачи.');
  if (!credentials) throw new Error('Подключите ключ Yandex AI Studio в настройках.');
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 40_000) throw new Error('Введите сообщение до 40 000 символов.');
  const chat = store.select(chatId);
  const model = lookupModel(chat.modelId ?? legacyModel.id);
  if (!model || !available.some(item => item.id === model.id)) {
    throw new Error('Выбранная модель отсутствует в каталоге. Выберите другую модель.');
  }
  const message = {
    id: store.beginTurn(chatId, text, model.id), chatId, modelId: model.id,
    role: 'assistant', text: '', tools: [], status: 'running',
  };
  const turn = { chatId, cwd: chat.cwd, message, tools: new Map(), permissions: [], sessionId: null };
  active = turn;
  emit('app:state', snapshot());

  try {
    if (runtime && runtime.modelId !== model.id) closeRuntime();
    runtime ??= await startRuntime(join(app.getPath('userData'), 'agent'), credentials, model);
    if (turn.stop) return;
    turn.client = new AcpClient(chat.cwd, runtime, {
      onUpdate: update => updateTurn(turn, update),
      onPermission: params => requestPermission(turn, params),
    });
    const init = await turn.client.request('initialize', {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'alicecode', title: 'Alicecode', version: app.getVersion() },
    });
    if (init._meta?.modelState?.currentModelId !== alias) {
      throw new Error(`Grok Build не загрузил модель ${model.label}.`);
    }
    const params = { cwd: chat.cwd, mcpServers: [] };
    if (chat.sessionId) {
      await turn.client.request('session/load', { ...params, sessionId: chat.sessionId });
      turn.sessionId = chat.sessionId;
    } else {
      const created = await turn.client.request('session/new', params);
      turn.sessionId = created.sessionId;
      store.setSession(chatId, turn.sessionId);
    }
    if (turn.stop) return;
    const result = await turn.client.request('session/prompt', {
      sessionId: turn.sessionId, prompt: [{ type: 'text', text }],
    }, 240_000);
    if (result.stopReason === 'cancelled') turn.stop = true;
    if (!turn.stop && !message.text && !turn.tools.size) throw new Error('Алиса вернула пустой ответ.');
    if (result.stopReason && !['end_turn', 'cancelled'].includes(result.stopReason)) {
      throw new Error(`Grok Build завершил задачу со статусом ${result.stopReason}.`);
    }
  } catch (error) {
    if (!turn.stop) message.error = String(error.message).slice(0, 1000);
  } finally {
    clearTimeout(turn.refresh);
    clearTimeout(turn.stopTimer);
    cancelPermissions(turn);
    turn.client?.close();
    message.status = turn.stop ? 'cancelled' : message.error ? 'error' : 'done';
    publishTurn(turn);
    active = undefined;
    emit('app:state', snapshot());
  }
}

function stop() {
  if (!active || active.stop) return;
  const turn = active;
  turn.stop = true;
  cancelPermissions(turn);
  emit('app:state', snapshot());
  if (turn.sessionId) turn.client.notify('session/cancel', { sessionId: turn.sessionId });
  turn.stopTimer = setTimeout(() => turn.client?.close(), 1800);
}

function bind(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Неподдерживаемый источник запроса.');
    }
    return fn(...args);
  });
}

function selectedPath(chatId) {
  return store.chat(chatId).cwd;
}

async function makeWindow() {
  window = new BrowserWindow({
    title: 'Alicecode', backgroundColor: '#f7f6fa',
    width: 1320, height: 850, minWidth: 760, minHeight: 580, show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  await window.loadFile(join(directory, 'ui', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    store = new Store(join(app.getPath('userData'), 'alicecode.sqlite'));
    try { await importCredentials(); } catch (error) { credentialError = error.message; }
    bind('app:state', snapshot);
    bind('project:create', async (name, parent) => {
      if (typeof name !== 'string') throw new Error('Введите имя проекта.');
      const base = parent || snapshot().projectRoot;
      const project = await createProject(base, name);
      store.set('projectRoot', resolve(base));
      store.addProject(project.title, project.path);
      return snapshot();
    });
    bind('project:choose', async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.filePaths[0] ?? null;
    });
    bind('project:open', async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      if (result.canceled) return snapshot();
      const path = await realpath(result.filePaths[0]);
      store.addProject(basename(path) || path, path);
      return snapshot();
    });
    bind('project:reveal', chatId => shell.openPath(selectedPath(chatId)));
    bind('project:inspect', async chatId => {
      const path = selectedPath(chatId);
      const [files, changes] = await Promise.all([listFiles(path), listChanges(path)]);
      return { files, changes };
    });
    bind('project:read', (chatId, path) => readProjectFile(selectedPath(chatId), path));
    bind('project:diff', (chatId, path) => readProjectDiff(selectedPath(chatId), path));
    bind('project:select', projectId => { store.selectProject(projectId); return snapshot(); });
    bind('project:rename', (id, title) => { store.renameProject(id, title); return snapshot(); });
    bind('chat:new', projectId => { store.addChat(projectId); return snapshot(); });
    bind('chat:select', chatId => { store.select(chatId); return snapshot(); });
    bind('chat:rename', (id, title) => { store.renameChat(id, title); return snapshot(); });
    bind('chat:model', (id, modelId) => {
      if (active?.chatId === id) throw new Error('Смените модель после завершения ответа.');
      if (!available.some(model => model.id === modelId)) throw new Error('Модель недоступна в каталоге.');
      store.setModel(id, modelId);
      return snapshot();
    });
    bind('history:search', query => store.search(query));
    bind('settings:layout', value => store.set('layout', JSON.stringify(normalizeLayout(value))));
    bind('settings:models', refreshModels);
    bind('chat:send', send);
    bind('chat:stop', stop);
    bind('chat:permission', (id, allow) => resolvePermission(id, allow === true));
    bind('updates:check', async () => { await updates.check(); return updates.snapshot(); });
    bind('updates:install', () => {
      if (active) throw new Error('Завершите текущую задачу перед обновлением.');
      updates.install();
    });
    bind('settings:save', async value => {
      if (active) throw new Error('Завершите текущую задачу перед сменой ключа.');
      await saveCredentials(value);
      void refreshModels();
      return snapshot();
    });
    await makeWindow();
    void refreshModels();
    updates.start();
  }).catch(error => {
    dialog.showErrorBox('Alicecode', error.message);
    app.exit(1);
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (active) {
    active.stop = true;
    clearTimeout(active.refresh);
    clearTimeout(active.stopTimer);
    cancelPermissions(active);
    active.client?.close();
    active.message.status = 'cancelled';
    publishTurn(active);
  }
  closeRuntime();
});
