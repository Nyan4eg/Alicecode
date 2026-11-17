import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { AcpClient, startRuntime } from './acp.mjs';
import { alias } from './adapter.mjs';
import { readPrototypeCredentials, validateCredentials } from './credentials.mjs';
import { createProject, listChanges, listDirectory, readProjectDiff, readProjectFile, searchFiles } from './workspace.mjs';
import { createUpdates } from './updates.mjs';
import { describePermission, mergeToolUpdate, nodeTestCounts } from './activity.mjs';
import { contextPrompt, previewContext, resolveContext } from './context.mjs';
import { finishReview, startReview } from './review.mjs';
import { replayDetails, runTest, testInvocation } from './replay.mjs';
import { defaultModel, fetchModels, legacyModel, models, modelsFor } from './models.mjs';
import { normalizeLayout } from './layout.mjs';
import { agentEdit, agentTextForDisk, editDiff, editableFile, editorText, planRollback, textForDisk, validateText, writeChecked } from './editing.mjs';
import { commitPreview, createCommit, gitHunks, stageFile, stageHunks } from './git.mjs';
import { Attachments } from './attachments.mjs';
import { createProvider, keyMode, providerError, subscriptionMode, validateSubscription } from './providers.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const cancelledPermission = () => ({ outcome: { outcome: 'cancelled' } });
app.setName('Alicecode');
app.setAppUserModelId('io.github.nyan4eg.alicecode');
const devProfile = !app.isPackaged && app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', devProfile || join(app.getPath('appData'), 'Alicecode'));
let window;
let store;
let attachments;
let credentials;
let credentialError;
let providerMode = keyMode;
const connections = new Map();
let runtime;
let active;
let workspaceMutation = false;
let available = models;
let catalogStatus = 'loading';
const updates = createUpdates(state => emit('app:update', state));

function snapshot() {
  const providerSettings = Object.fromEntries([...connections].map(([mode, value]) => [mode, {
    folderId: value.folderId, tokenSource: value.tokenSource, cliProfile: value.cliProfile,
  }]));
  return {
    ...store.snapshot(), configured: Boolean(credentials), credentialError,
    busy: active?.chatId ?? null, busyStage: active?.stage ?? null, permission: active?.permissions[0]?.details ?? null,
    workspaceMutation,
    updates: updates.snapshot(),
    models: available, defaultModel: defaultModel.id, catalogStatus, providerMode, providerSettings,
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
  const mode = value.mode === subscriptionMode ? subscriptionMode : keyMode;
  const existing = connections.get(mode);
  const next = mode === subscriptionMode
    ? validateSubscription({ ...value, iamToken: value.iamToken || existing?.iamToken || '' })
    : validateCredentials({ ...value, apiKey: value.apiKey || existing?.apiKey || '' });
  const bytes = await safeStorage.encryptStringAsync(JSON.stringify(next));
  assertIdle();
  store.set(mode === subscriptionMode ? 'subscriptionCredentials' : 'credentials', bytes.toString('base64'));
  store.set('providerMode', mode);
  connections.set(mode, next);
  activateCredentials(mode);
}

function activateCredentials(mode) {
  closeRuntime();
  providerMode = mode;
  credentials = connections.get(mode);
  credentialError = credentials ? null : credentialError;
  available = modelsFor(mode);
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
    catalogStatus = source.mode === subscriptionMode ? 'documented' : 'ready';
  } catch {
    if (credentials !== source) return;
    catalogStatus = 'error';
  }
  emit('app:catalog', { models: available, catalogStatus });
}

async function importCredentials() {
  const mode = store.setting('providerMode') === subscriptionMode ? subscriptionMode : keyMode;
  for (const [kind, setting, validate] of [[keyMode, 'credentials', validateCredentials],
    [subscriptionMode, 'subscriptionCredentials', validateSubscription]]) {
    try {
      const saved = store.setting(setting);
      if (saved) {
        const { result } = await safeStorage.decryptStringAsync(Buffer.from(saved, 'base64'));
        connections.set(kind, validate(JSON.parse(result)));
      } else if (kind === keyMode && !devProfile) {
        const value = await readPrototypeCredentials();
        if (value) {
          const bytes = await safeStorage.encryptStringAsync(JSON.stringify(value));
          store.set(setting, bytes.toString('base64'));
          connections.set(kind, value);
        }
      }
    } catch (error) {
      if (kind === mode) credentialError = error.message;
    }
  }
  activateCredentials(mode);
}

async function checkConnection() {
  if (!credentials) throw new Error('Сначала сохраните настройки подключения.');
  const source = credentials;
  const provider = createProvider(source);
  const { response, redact } = await provider.request('/chat/completions', {
    method: 'POST',
    headers: { 'OpenAI-Project': source.folderId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: provider.model(source.folderId, available[0]?.id ?? defaultModel.id),
      messages: [{ role: 'user', content: 'Ответь OK.' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const message = providerError(source.mode, response.status) ?? redact(await response.text()).slice(0, 500);
    if (!response.bodyUsed) await response.body?.cancel();
    throw new Error(message || 'Yandex вернул HTTP ' + response.status);
  }
  await response.body?.cancel();
  if (source !== credentials) throw new Error('Подключение сменилось. Запустите проверку ещё раз.');
  return true;
}

function updateTurn(turn, { sessionId, update }) {
  if (turn.sessionId !== sessionId || turn.stop) return;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    turn.message.text += update.content.text;
  } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const prior = turn.tools.get(update.toolCallId) ?? {};
    const tool = mergeToolUpdate(prior, update, turn.cwd);
    if (tool.cwd && Number.isInteger(tool.exitCode) && !tool.background && !tool.interrupted && testInvocation(tool.command)) {
      tool.repeatable = true;
    }
    turn.tools.set(update.toolCallId, tool);
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

function enqueuePermission(turn, details, choose) {
  if (turn.stop || active !== turn) return cancelledPermission();
  return new Promise(resolvePermission => {
    turn.permissions.push({ details, choose, resolvePermission });
    emit('app:state', snapshot());
  });
}

async function requestPermission(turn, params) {
  const permit = params.options.find(option => option.kind === 'allow_once');
  if (!permit) return cancelledPermission();
  const reject = params.options.find(option => option.kind === 'reject_once');
  const tool = params.toolCall;
  const details = { id: tool.toolCallId, chatId: turn.chatId, ...describePermission(tool, turn.cwd, turn.shellCwd) };
  if (details.kind === 'edit' && details.changes.some(change => attachments.isSnapshot(change.path, turn.cwd))) {
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : cancelledPermission();
  }
  let proposed;
  if (details.kind === 'edit' && details.changes.length === 1) {
    try {
      const before = await editableFile(turn.cwd, details.changes[0].path, true);
      const text = agentEdit(tool, before);
      if (typeof text === 'string') proposed = { ...before, after: text };
    } catch {}
  }
  return enqueuePermission(turn, details, allow => {
    if (allow && proposed) turn.approvedEdits.set(proposed.path, proposed);
    const optionId = allow ? permit.optionId : reject?.optionId;
    return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission();
  });
}

function resolvePermission(id, allow) {
  const p = active?.permissions[0];
  if (!p || p.details.id !== id) return;
  active.permissions.shift();
  if (p.details.kind !== 'managed-write') {
    const tool = active.tools.get(id) ?? { id, title: p.details.title };
    active.tools.set(id, { ...tool, decision: allow ? 'allowed' : 'denied' });
    publishTurn(active);
  }
  p.resolvePermission(p.choose(allow));
  emit('app:state', snapshot());
}

function cancelPermissions(turn) {
  for (const pending of turn.permissions.splice(0)) pending.resolvePermission(cancelledPermission());
}

async function fileRequest(turn, method, params) {
  const check = () => {
    if (active !== turn || turn.stop || (turn.sessionId && turn.sessionId !== params.sessionId)) {
      throw new Error('Сессия больше не активна.');
    }
  };
  check();
  if (method === 'fs/read_text_file') {
    let text = await attachments.read(turn.chatId, turn.attachments, params.path);
    if (text === null) {
      const file = await editableFile(turn.cwd, params.path);
      turn.fileReads.set(file.path, file.stamp);
      text = file.text;
    }
    if (!params.line && !params.limit) return { content: text };
    const first = Math.max(0, (params.line ?? 1) - 1);
    return { content: text.split(/\r?\n/).slice(first, first + (params.limit ?? Infinity)).join('\n') };
  }
  if (!turn.sessionId) throw new Error('Сессия ещё не открыта.');
  if (attachments.isSnapshot(params.path, turn.cwd)) throw new Error('Вложения доступны только для чтения.');
  validateText(params.content);
  const file = await editableFile(turn.cwd, params.path, true);
  const approved = turn.approvedEdits.get(file.path);
  turn.approvedEdits.delete(file.path);
  const readStamp = turn.fileReads.get(file.path);
  if ((approved && approved.stamp !== file.stamp) || (readStamp !== undefined && readStamp !== file.stamp)) {
    throw new Error('Файл изменился после чтения. Прочитайте его ещё раз перед правкой.');
  }
  const content = agentTextForDisk(file.text, params.content);
  if (content === file.text) return {};
  if (!approved || approved.after !== params.content) {
    const patch = await editDiff(file.text, content);
    const allow = await enqueuePermission(turn, { id: randomUUID(), chatId: turn.chatId, kind: 'managed-write',
      title: 'Применить правку к файлу?', path: file.path, patch }, value => value);
    if (allow !== true) throw new Error('Пользователь отклонил запись файла.');
  }
  check();
  // Record only writes performed by the host. A shell command can also change the working tree.
  const receipt = file.text === null ? null : store.startManagedEdit(turn.message.id, file.path, file.text, content);
  let applied = false;
  try {
    const written = await writeChecked(turn.cwd, file, content, check);
    turn.fileReads.set(file.path, written.stamp);
    applied = true;
  } finally {
    if (receipt !== null) store.finishManagedEdit(receipt, applied);
  }
  return {};
}

function assertIdle() {
  if (active || workspaceMutation) throw new Error('Дождитесь завершения текущей операции.');
}

async function mutateWorkspace(operation) {
  assertIdle();
  workspaceMutation = true;
  emit('app:state', snapshot());
  try { return await operation(); }
  finally {
    workspaceMutation = false;
    emit('app:state', snapshot());
  }
}

async function prepareReview(turn) {
  try { return await startReview(turn.cwd); } catch { return undefined; }
}

async function completeTurn(turn, baseline) {
  clearTimeout(turn.refresh);
  clearTimeout(turn.stopTimer);
  cancelPermissions(turn);
  turn.client?.close();
  turn.stage = 'review';
  emit('app:state', snapshot());
  let review;
  try {
    if (baseline === undefined) throw new Error('No baseline');
    review = await finishReview(turn.cwd, baseline);
  } catch {
    review = { state: 'unavailable', files: [], note: 'Не удалось сравнить файлы до и после запуска.' };
  }
  try {
    turn.message.review = store.saveReview(turn.message.id, review);
    turn.message.status = turn.stop ? 'cancelled' : turn.message.error ? 'error' : 'done';
    publishTurn(turn);
  } finally {
    active = undefined;
    emit('app:state', snapshot());
  }
}

async function send(chatId, input, refs = [], externalIds = []) {
  assertIdle();
  if (!credentials) throw new Error('Настройте подключение к Yandex.');
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 40_000) throw new Error('Введите сообщение до 40 000 символов.');
  const context = await resolveContext(store.chat(chatId).cwd, refs);
  const external = attachments.files(chatId, externalIds);
  assertIdle();
  const chat = store.select(chatId);
  if (chat.archivedAt) throw new Error('Восстановите чат из архива.');
  const model = available.find(item => item.id === (chat.modelId ?? legacyModel.id));
  if (!model) {
    throw new Error('Выбранная модель отсутствует в каталоге. Выберите другую модель.');
  }
  const message = {
    id: store.beginTurn(chatId, text, model.id, [...context.map(({ path, start, end }) => ({ path, start, end })),
      ...external.map(({ text, ...item }) => item)]),
    chatId, modelId: model.id,
    role: 'assistant', text: '', tools: [], status: 'running',
  };
  const turn = { chatId, cwd: chat.cwd, message, tools: new Map(), permissions: [], sessionId: null, stage: 'prepare',
    approvedEdits: new Map(), fileReads: new Map(), attachments: store.externalAttachments(chatId) };
  active = turn;
  emit('app:state', snapshot());
  const baseline = await prepareReview(turn);

  try {
    if (turn.stop) return;
    await attachments.save(chatId, external);
    if (turn.stop) return;
    turn.stage = 'agent';
    emit('app:state', snapshot());
    if (runtime && runtime.modelId !== model.id) closeRuntime();
    runtime ??= await startRuntime(join(app.getPath('userData'), 'agent'), credentials, model);
    if (turn.stop) return;
    turn.client = new AcpClient(chat.cwd, runtime, {
      onUpdate: update => updateTurn(turn, update),
      onPermission: params => requestPermission(turn, params),
      onRequest: (method, params) => fileRequest(turn, method, params),
    });
    const init = await turn.client.request('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
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
      sessionId: turn.sessionId, prompt: [text, ...context.map(contextPrompt), ...attachments.prompt(chatId, external)]
        .map(text => ({ type: 'text', text })),
    }, 240_000);
    if (result.stopReason === 'cancelled') turn.stop = true;
    if (!turn.stop && !message.text && !turn.tools.size) throw new Error('Алиса вернула пустой ответ.');
    if (result.stopReason && !['end_turn', 'cancelled'].includes(result.stopReason)) {
      throw new Error(`Grok Build завершил задачу со статусом ${result.stopReason}.`);
    }
  } catch (error) {
    if (!turn.stop) message.error = String(error.message).slice(0, 1000);
  } finally {
    await completeTurn(turn, baseline);
  }
}

async function getReplay(chatId, messageId, toolId) {
  const { cwd, archivedAt } = store.chat(chatId);
  if (archivedAt) throw new Error('Восстановите чат из архива.');
  const details = await replayDetails(cwd, store.messageTool(chatId, messageId, toolId));
  if (!details) throw new Error('Эту команду нельзя повторить из журнала. Нужен отдельный запуск тестов в папке проекта.');
  return details;
}

async function replay(chatId, messageId, toolId, confirmedDirectory) {
  assertIdle();
  const details = await getReplay(chatId, messageId, toolId);
  if (details.cwd !== confirmedDirectory) throw new Error('Рабочая папка изменилась. Откройте подтверждение заново.');
  assertIdle();
  const chat = store.select(chatId);
  const tool = { id: 'replay', kind: 'execute', title: 'Повтор тестов', command: details.command,
    cwd: details.cwd, status: 'in_progress', local: true };
  const message = { id: store.beginReplay(chatId, tool), chatId, role: 'assistant', text: '', tools: [tool], status: 'running' };
  const turn = { chatId, cwd: chat.cwd, message, tools: new Map([[tool.id, tool]]), permissions: [],
    abort: new AbortController(), stage: 'prepare' };
  active = turn;
  emit('app:state', snapshot());
  const baseline = await prepareReview(turn);
  try {
    if (turn.stop) return;
    turn.stage = 'test';
    emit('app:state', snapshot());
    const { error, ...result } = await runTest(details, turn.abort.signal);
    Object.assign(tool, result, { status: error ? 'failed' : 'completed', tests: nodeTestCounts(result.output),
      repeatable: !result.interrupted && Number.isInteger(result.exitCode) });
    if (error && !turn.stop) message.error = error;
  } catch (error) {
    tool.status = 'failed';
    if (!turn.stop) message.error = error.message;
  } finally {
    await completeTurn(turn, baseline);
  }
}

function stop() {
  if (!active || active.stop || active.stage === 'review') return;
  const turn = active;
  turn.stop = true;
  turn.abort?.abort();
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

async function editorFile(chatId, path) {
  const file = await editableFile(selectedPath(chatId), path);
  return { path: file.path, stamp: file.stamp, text: editorText(file.text) };
}

async function saveEditor(chatId, path, expected, draft) {
  const root = selectedPath(chatId);
  const file = await editableFile(root, path);
  const text = textForDisk(file.text, draft);
  if (file.stamp !== expected) return { conflict: true, path: file.path, stamp: file.stamp,
    text: editorText(file.text), patch: await editDiff(file.text, text) };
  const saved = await writeChecked(root, file, text);
  return { path: saved.path, stamp: saved.stamp, text: editorText(saved.text) };
}

async function rollbackDetails(chatId, messageId, path) {
  const root = selectedPath(chatId);
  const edits = store.managedEdits(chatId, messageId, path);
  const result = await planRollback(root, path, edits);
  return { root, edits, result };
}

async function removeLocalSessions() {
  const pending = store.sessionsToRemove();
  if (!pending.length) return;
  const home = join(app.getPath('userData'), 'agent', 'sessions');
  try {
    if (!(await lstat(home)).isDirectory() || relative(await realpath(home), home)) return;
  } catch (error) {
    if (error.code === 'ENOENT') for (const id of pending) store.finishSessionRemoval(id);
    return;
  }
  let groups;
  try { groups = await readdir(home, { withFileTypes: true }); } catch { return; }
  for (const id of pending) {
    if (!/^[a-z0-9_-]{8,128}$/i.test(id)) continue;
    try {
      for (const group of groups.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())) {
        const folder = join(home, group.name, id);
        const entry = await lstat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
        const actual = await realpath(folder);
        if (relative(folder, actual) || relative(home, dirname(dirname(actual)))) continue;
        await rm(actual, { recursive: true, force: true });
      }
      store.finishSessionRemoval(id);
    } catch {
      // The pending deletion will be retried when the profile opens.
    }
  }
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
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: 'Несохранённые изменения',
      message: 'В редакторе есть несохранённые файлы.', buttons: ['Вернуться', 'Закрыть без сохранения'],
      cancelId: 0, defaultId: 0 });
    if (choice === 1) event.preventDefault();
  });
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
    attachments = await Attachments.open(join(app.getPath('userData'), 'context-files'));
    await removeLocalSessions();
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
    bind('project:inspect', async chatId => ({ changes: await listChanges(selectedPath(chatId)) }));
    bind('project:directory', (chatId, path) => listDirectory(selectedPath(chatId), path));
    bind('project:search-files', (chatId, query) => searchFiles(selectedPath(chatId), query));
    bind('project:read', (chatId, path) => readProjectFile(selectedPath(chatId), path));
    bind('project:editor', editorFile);
    bind('project:save-file', (...args) => mutateWorkspace(() => saveEditor(...args)));
    bind('project:diff', (chatId, path, scope) => readProjectDiff(selectedPath(chatId), path, scope));
    bind('project:context', (chatId, path, start, end) => previewContext(selectedPath(chatId), path, start, end));
    bind('attachment:choose', async (chatId, kind) => {
      store.chat(chatId);
      const properties = kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'];
      const choice = await dialog.showOpenDialog(window, { properties });
      return choice.canceled ? null : attachments.choose(chatId, choice.filePaths);
    });
    bind('attachment:drop', (chatId, paths) => {
      store.chat(chatId);
      return attachments.choose(chatId, paths);
    });
    bind('attachment:preview', (...args) => attachments.preview(...args));
    bind('attachment:attach', (chatId, ...args) => {
      store.chat(chatId);
      return attachments.attach(chatId, ...args);
    });
    bind('attachment:remove', (chatId, id) => attachments.remove(chatId, [id]));
    bind('attachment:read', async (chatId, id) => {
      const item = store.externalAttachments(chatId).find(file => file.id === id);
      if (!item) throw new Error('Вложение не найдено.');
      const text = await attachments.read(chatId, [item], attachments.path(chatId, item));
      return { label: item.label, text: text.slice(0, 20000), truncated: text.length > 20000 };
    });
    bind('git:stage', (chatId, path, staged) => mutateWorkspace(() => stageFile(selectedPath(chatId), path, staged === true)));
    bind('git:hunks', (chatId, path, scope) => gitHunks(selectedPath(chatId), path, scope));
    bind('git:stage-hunks', (chatId, ...args) => mutateWorkspace(() => stageHunks(selectedPath(chatId), ...args)));
    bind('git:commit-preview', chatId => commitPreview(selectedPath(chatId)));
    bind('git:commit', (chatId, token, message) => mutateWorkspace(() => createCommit(selectedPath(chatId), token, message)));
    bind('chat:review-file', (chatId, messageId, path) => store.reviewFile(chatId, messageId, path));
    bind('chat:rollback-preview', async (chatId, messageId, path) => {
      const { root, result } = await rollbackDetails(chatId, messageId, path);
      const staged = (await listChanges(root)).some(item => item.path === path && item.staged);
      return { token: result.token, conflict: result.conflict, patch: result.patch, staged };
    });
    bind('chat:rollback', (chatId, messageId, path, token) => mutateWorkspace(async () => {
      const { root, edits, result } = await rollbackDetails(chatId, messageId, path);
      if (token !== result.token || result.conflict) throw new Error('Файл изменился. Откройте предпросмотр отката заново.');
      await writeChecked(root, result.file, result.text);
      store.markRolledBack(edits);
    }));
    bind('project:select', projectId => { store.selectProject(projectId); return snapshot(); });
    bind('project:rename', (id, title) => { store.renameProject(id, title); return snapshot(); });
    bind('chat:new', projectId => { store.addChat(projectId); return snapshot(); });
    bind('chat:select', chatId => { store.select(chatId); return snapshot(); });
    bind('chat:rename', (id, title) => { store.renameChat(id, title); return snapshot(); });
    bind('chat:archive', (id, archived) => {
      if (active?.chatId === id) throw new Error('Завершите задачу перед архивированием.');
      store.archiveChat(id, archived === true);
      return snapshot();
    });
    bind('chat:delete', async id => {
      if (active?.chatId === id || workspaceMutation) throw new Error('Завершите текущую операцию перед удалением.');
      store.deleteChat(id);
      await Promise.all([removeLocalSessions(), attachments.removeChat(id)]);
      return snapshot();
    });
    bind('chat:model', (id, modelId) => {
      if (active?.chatId === id) throw new Error('Смените модель после завершения ответа.');
      if (store.chat(id).archivedAt) throw new Error('Восстановите чат из архива.');
      if (!available.some(model => model.id === modelId)) throw new Error('Модель недоступна в каталоге.');
      store.setModel(id, modelId);
      return snapshot();
    });
    bind('history:search', (query, includeArchived) => store.search(query, includeArchived));
    bind('settings:layout', value => store.set('layout', JSON.stringify(normalizeLayout(value))));
    bind('settings:models', refreshModels);
    bind('settings:check-provider', checkConnection);
    bind('chat:send', send);
    bind('chat:stop', stop);
    bind('chat:permission', (id, allow) => resolvePermission(id, allow === true));
    bind('chat:replay-details', async (chatId, messageId, toolId) => {
      const { command, cwd } = await getReplay(chatId, messageId, toolId);
      return { command, cwd };
    });
    bind('chat:replay-test', replay);
    bind('updates:check', async () => { await updates.check(); return updates.snapshot(); });
    bind('updates:install', () => {
      assertIdle();
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
    active.abort?.abort();
    clearTimeout(active.refresh);
    clearTimeout(active.stopTimer);
    cancelPermissions(active);
    active.client?.close();
    active.message.status = 'cancelled';
    publishTurn(active);
  }
  closeRuntime();
});
