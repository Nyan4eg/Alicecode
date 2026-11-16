import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { basename, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Store } from './store.mjs';
import { AcpClient, startRuntime } from './acp.mjs';
import { alias } from './adapter.mjs';
import { readPrototypeCredentials, validateCredentials } from './credentials.mjs';
import { createProject, listChanges, listFiles, readProjectFile } from './workspace.mjs';
import { createUpdates } from './updates.mjs';

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
const updates = createUpdates(state => emit('app:update', state));

function snapshot() {
  return {
    ...store.snapshot(), configured: Boolean(credentials), credentialError,
    busy: active?.chatId ?? null, permission: active?.permission?.details ?? null,
    updates: updates.snapshot(),
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

function summarizeOutput(content) {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (item.type === 'content' && item.content?.type === 'text') return stripVTControlCharacters(item.content.text);
    if (item.type === 'diff') return `Изменён файл ${item.path}`;
    return '';
  }).filter(Boolean).join('\n').slice(0, 16_000);
}

function updateTurn(turn, { sessionId, update }) {
  if (turn.sessionId !== sessionId || turn.stop) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    turn.message.text += update.content.text;
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const prior = turn.tools.get(update.toolCallId) ?? { id: update.toolCallId };
    turn.tools.set(update.toolCallId, {
      ...prior,
      title: update.title ?? prior.title ?? 'Инструмент',
      kind: update.kind ?? prior.kind,
      status: update.status ?? prior.status,
      output: update.content ? summarizeOutput(update.content) || prior.output : prior.output,
    });
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
  return new Promise(resolvePermission => {
    const details = {
      chatId: turn.chatId,
      title: params.toolCall.title ?? 'Вызов инструмента',
      input: typeof params.toolCall.rawInput === 'object'
        ? JSON.stringify(params.toolCall.rawInput, null, 2).slice(0, 4_000)
        : String(params.toolCall.rawInput ?? '').slice(0, 4_000),
    };
    if (turn.permission) return resolvePermission(cancelledPermission());
    turn.permission = { details, permit: permit.optionId, resolvePermission };
    emit('app:state', snapshot());
  });
}

function resolvePermission(allow) {
  const p = active?.permission;
  if (!p) return;
  active.permission = null;
  p.resolvePermission(allow ? { outcome: { outcome: 'selected', optionId: p.permit } } : cancelledPermission());
  emit('app:state', snapshot());
}

async function send(chatId, input) {
  if (active) throw new Error('Дождитесь завершения текущей задачи.');
  if (!credentials) throw new Error('Подключите ключ Yandex AI Studio в настройках.');
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 40_000) throw new Error('Введите сообщение до 40 000 символов.');
  const chat = store.select(chatId);
  const message = { id: store.beginTurn(chatId, text), chatId, role: 'assistant', text: '', tools: [], status: 'running' };
  const turn = { chatId, message, tools: new Map(), sessionId: null };
  active = turn;
  emit('app:state', snapshot());

  try {
    runtime ??= await startRuntime(join(app.getPath('userData'), 'agent'), credentials);
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
      throw new Error('Grok Build не выбрал модель Alice AI LLM Flash.');
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
    resolvePermission(false);
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
  resolvePermission(false);
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
    bind('chat:new', projectId => { store.addChat(projectId); return snapshot(); });
    bind('chat:select', chatId => { store.select(chatId); return snapshot(); });
    bind('chat:send', send);
    bind('chat:stop', stop);
    bind('chat:permission', allow => resolvePermission(allow === true));
    bind('updates:check', async () => { await updates.check(); return updates.snapshot(); });
    bind('updates:install', () => {
      if (active) throw new Error('Завершите текущую задачу перед обновлением.');
      updates.install();
    });
    bind('settings:save', async value => {
      if (active) throw new Error('Завершите текущую задачу перед сменой ключа.');
      await saveCredentials(value);
      return snapshot();
    });
    await makeWindow();
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
    resolvePermission(false);
    active.client?.close();
    active.message.status = 'cancelled';
    publishTurn(active);
  }
  closeRuntime();
});
