import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { Store } from './store.mjs';
import { AcpClient, startRuntime } from './acp.mjs';
import { alias } from './adapter.mjs';
import { readPrototypeCredentials, validateCredentials } from './credentials.mjs';
import { createProject, listChanges, listDirectory, readProjectDiff, readProjectFile, searchFiles, searchContent } from './workspace.mjs';
import { discuss } from './discussion.mjs';
import { consent } from './permissions.mjs';
import { projectInstructions, profileInstructions, saveInstructions, instructionsPrompt } from './instructions.mjs';
import { generatePlan, validatePlan, finishStep } from './task-plan.mjs';
import { createTaskWorkspace, transferPreview, applyTransfer, taskWorkspaceDetails, removeTaskWorkspace } from './task-workspace.mjs';
import { CommandRuns, commandProfile, commandEnvironment, commandDirectory, commandsPrompt } from './project-commands.mjs';
import { AffectedChecks } from './affected-checks.mjs';
import { discoverProfiles, localProfiles, repositoryProfiles, saveRepositoryProfiles } from './repository-profiles.mjs';
import { createUpdates } from './updates.mjs';
import { describePermission, mergeToolUpdate, nodeTestCounts } from './activity.mjs';
import { contextPrompt, previewContext, resolveContext } from './context.mjs';
import { finishReview, startReview } from './review.mjs';
import { replayDetails, runTest, testInvocation } from './replay.mjs';
import { defaultModel, fetchModels, legacyModel, models, modelsFor } from './models.mjs';
import { normalizeLayout } from './layout.mjs';
import { agentEdit, agentTextForDisk, editDiff, editableFile, editorText, fingerprint, planRollback, textForDisk, validateText, writeChecked } from './editing.mjs';
import { commitPreview, createCommit, gitHunks, stageFile, stageHunks } from './git.mjs';
import { Attachments } from './attachments.mjs';
import { createProvider, keyMode, providerError, subscriptionMode, validateSubscription } from './providers.mjs';
import { monitoredProvider } from './requests.mjs';
import { codeQuery, profileConfig } from './code-service.mjs';
import { checkKind, codeVersion, fileRevision } from './revision.mjs';
import { inspectFragments, suggestContext, summarize, summaryPrompt } from './conversation-context.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const cancelledPermission = () => ({ outcome: { outcome: 'cancelled' } });
app.setName('Alicecode');
app.setAppUserModelId('io.github.nyan4eg.alicecode');
const devProfile = !app.isPackaged && app.commandLine.getSwitchValue('user-data-dir');
app.setPath('userData', devProfile || join(app.getPath('appData'), 'Alicecode'));
let window;
let store;
let attachments;
let commands;
let compression;
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
const requestOwners = new Map(), analysisWatchers = new Map(), revisions = new Map();
function requestObserver(owner = null) {
  return event => {
    let previous = requestOwners.get(event.id);
    if (!previous) {
      const target = owner ?? (active ? { chatId: active.chatId, messageId: active.message.id, kind: active.stage } : null);
      if (!target) return;
      previous = { ...target }; requestOwners.set(event.id, previous);
    }
    const events = [...(previous.events ?? []), { phase: event.phase, attempt: event.attempt, reason: event.reason?.slice(0, 500), elapsedMs: event.elapsedMs }].slice(-12);
    const value = { ...previous, ...event, events, reason: event.reason?.slice(0, 500) };
    requestOwners.set(event.id, value); store.saveRequest(value); emit('api:request', value);
    if (['done', 'error', 'cancelled'].includes(event.phase)) requestOwners.delete(event.id);
  };
}
function taskProvider(owner = null) { return monitoredProvider(createProvider(credentials), requestObserver(owner)); }
function staleAnalysis(root) {
  revisions.set(root, (revisions.get(root) ?? 0) + 1);
  for (const [key,data] of Object.entries(store.analyses())) {
    if (data.root !== root || data.stale) continue;
    store.saveAnalysis(key, { ...data, stale: true }); emit('analysis:stale', key);
  }
}
function watchAnalysis(root) {
  if (analysisWatchers.has(root)) return;
  try {
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      if (file && file.split(/[\\/]/).some(part => ['node_modules', '.git', '.venv'].includes(part))) return;
      emit('checks:changed', root);
      if (!file || file.replaceAll('\\','/').toLowerCase().startsWith('.alicecode')) emit('profiles:changed',root);
      if (file && file.split(/[\\/]/).some(part => ['dist', 'build'].includes(part))) return;
      staleAnalysis(root);
    }); watcher.on('error', () => {}); analysisWatchers.set(root, watcher);
    if (analysisWatchers.size > 8) { const [old, prior] = analysisWatchers.entries().next().value; prior.close(); analysisWatchers.delete(old); }
  } catch {}
}

function snapshot() {
  const providerSettings = Object.fromEntries([...connections].map(([mode, value]) => [mode, {
    folderId: value.folderId, tokenSource: value.tokenSource, cliProfile: value.cliProfile,
  }]));
  const saved = store.snapshot(), chat = saved.chats.find(item => item.id === saved.activeChat);
  const profileSets = Object.fromEntries(saved.projects.map(p => [p.id, store.profiles(p.id).map(commandProfile)]));
  return {
    ...saved, configured: Boolean(credentials), credentialError, profileSets,
    chatStates: store.workspaceStates('chat'), projectStates: store.workspaceStates('project'),
    editorStates: store.workspaceStates('editor'),
    projectProfiles: Object.fromEntries(saved.projects.map(p => [p.id, profileSets[p.id].find(profile => p.id === chat?.projectId && profile.id === chat.profileId) ?? profileSets[p.id][0]])),
    commandRuns: store.commands(), taskWorkspaces: store.taskWorkspaces(),
    reviewNotes: store.notes(store.setting('activeChat') ?? ''),
    apiRequests: store.requests(), analyses: store.analyses(),
    draftFiles: Object.fromEntries([...attachments.drafts].map(([id, files]) => [id, [...files.values()].map(({ text, ...file }) => file)])),
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
    commands.recordAgent(turn, tool);
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
  return consent(turn, details, choose, { isActive: () => active === turn,
    record: (details, allowed, automatic) => recordDecision(turn, details, allowed, automatic),
    changed: () => emit('app:state', snapshot()) });
}

function recordDecision(turn, details, allow, automatic = false) {
  const tool = turn.tools.get(details.id) ?? { id: details.id, title: details.title, kind: details.kind === 'managed-write' ? 'edit' : details.kind,
    ...(details.path ? { paths: [details.path] } : {}), ...(details.command ? { command: details.command } : {}) };
  turn.tools.set(details.id, { ...tool, decision: allow ? 'allowed' : 'denied', automatic,
    ...(details.kind === 'managed-write' ? { status: allow ? 'in_progress' : 'failed' } : {}) });
  publishTurn(turn);
}

async function requestPermission(turn, params) {
  if (turn.mode === 'discuss') return cancelledPermission();
  const permit = params.options.find(option => option.kind === 'allow_once') ?? params.options.find(option => option.kind.startsWith('allow'));
  if (!permit) return cancelledPermission();
  const reject = params.options.find(option => option.kind === 'reject_once');
  const tool = params.toolCall;
  const details = { id: tool.toolCallId, chatId: turn.chatId, ...describePermission(tool, turn.cwd, turn.shellCwd) };
  if (turn.approval !== 'bypass' && details.kind === 'edit' && details.changes.some(change => attachments.isSnapshot(change.path, turn.cwd))) {
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
  const decision = await enqueuePermission(turn, details, allow => {
    if (allow && proposed) turn.approvedEdits.set(proposed.path, proposed);
    const optionId = allow ? permit.optionId : reject?.optionId;
    return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission();
  });
  if (decision?.outcome?.optionId === permit.optionId && checkKind(details.command, turn.message.task?.profile)) {
    turn.checkVersions.set(details.id, await commands.fingerprint(turn.cwd, turn.message.task.profile));
  }
  return decision;
}

function resolvePermission(id, allow) {
  const p = active?.permissions[0];
  if (!p || p.details.id !== id) return;
  active.permissions.shift();
  recordDecision(active, p.details, allow);
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
  if (turn.mode === 'discuss') throw new Error('В режиме обсуждения запись заблокирована.');
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
  let writeApprovalId;
  if (!approved || approved.after !== params.content) {
    const patch = await editDiff(file.text, content);
    writeApprovalId = randomUUID();
    const allow = await enqueuePermission(turn, { id: writeApprovalId, chatId: turn.chatId, kind: 'managed-write',
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
    if (writeApprovalId && turn.tools.has(writeApprovalId)) {
      turn.tools.set(writeApprovalId, { ...turn.tools.get(writeApprovalId), status: applied ? 'completed' : 'failed' });
      publishTurn(turn);
    }
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

async function mutateState(operation) {
  await mutateWorkspace(operation);
  return snapshot();
}

async function prepareReview(turn) {
  try { return await startReview(turn.cwd); } catch { return undefined; }
}

async function completeTurn(turn, baseline) {
  clearTimeout(turn.refresh);
  clearTimeout(turn.stopTimer);
  cancelPermissions(turn);
  turn.client?.close();
  commands.finishAgent(turn.message.id);
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
    if (turn.message.task) {
      turn.message.task.status = turn.stop ? 'stopped' : turn.message.error ? 'error' : 'done';
      for (const step of turn.message.task.steps) if (step.status === 'running') { step.status = turn.stop ? 'stopped' : 'error'; step.note = turn.message.error; }
    }
    publishTurn(turn);
  } finally {
    active = undefined;
    emit('app:state', snapshot());
  }
}

async function send(chatId, input, refs = [], externalIds = [], resume = null, reviewNotes = [], repairProfile = null) {
  assertIdle();
  if (!credentials) throw new Error('Настройте подключение к Yandex.');
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 40_000) throw new Error('Введите сообщение до 40 000 символов.');
  const selected = store.chat(chatId);
  const combined = [...new Map([...selected.pins, ...refs].map(ref => [ref.path + ':' + ref.start + ':' + ref.end, ref])).values()];
  const context = await resolveContext(selected.cwd, combined);
  const external = attachments.files(chatId, externalIds);
  assertIdle();
  const chat = store.select(chatId);
  if (chat.archivedAt) throw new Error('Восстановите чат из архива.');
  const model = available.find(item => item.id === (chat.modelId ?? legacyModel.id));
  if (!model) {
    throw new Error('Выбранная модель отсутствует в каталоге. Выберите другую модель.');
  }
  const profile = commandProfile(resume?.profile ?? repairProfile ?? store.selectedProfile(chat));
  const instructionSnapshot = resume?.instructions ?? await profileInstructions(chat.cwd,profile);
  const commandEnv = chat.mode === 'code' ? await commandEnvironment(profile) : null;
  assertIdle();
  const task = { root: chat.cwd, workspace: chat.workspace, approval: chat.approval, instructions: instructionSnapshot, profile, summary: chat.summary,
    source: resume?.source ?? text, steps: resume?.steps?.map(step => ({ ...step, status: step.status === 'done' ? 'done' : 'pending' })) ?? [], status: 'running' };
  const message = {
    id: store.beginTurn(chatId, text, model.id, [...context.map(({ path, start, end }) => ({ path, start, end })),
      ...external.map(({ text, ...item }) => item)], chat.mode, reviewNotes),
    chatId, modelId: model.id, mode: chat.mode, task,
    role: 'assistant', text: '', tools: [], status: 'running',
  };
  const savedWorkspace = store.workspaceStates('chat')[chatId];
  if (savedWorkspace && !reviewNotes.length && !repairProfile) store.saveWorkspace('chat', chatId, { ...savedWorkspace, draft: '', context: [] });
  const turn = { chatId, mode: chat.mode, approval: chat.approval, abort: new AbortController(), cwd: chat.cwd, message, tools: new Map(), permissions: [], sessionId: null, stage: 'prepare',
    approvedEdits: new Map(), fileReads: new Map(), checkVersions: new Map(), attachments: store.externalAttachments(chatId) };
  active = turn;
  emit('app:state', snapshot());
  const baseline = await prepareReview(turn);

  try {
    if (turn.stop) return;
    await attachments.save(chatId, external);
    if (turn.stop) return;
    turn.stage = 'agent';
    emit('app:state', snapshot());
    const referenceCatalog = turn.attachments.length ? 'Справочные вложения этого чата (только чтение, доступны встроенным инструментом чтения):\n'
      + [...new Map(turn.attachments.map(file => [file.id, file])).values()].slice(-32)
        .map(file => JSON.stringify(file.label) + ': ' + JSON.stringify(attachments.path(chatId, file).replaceAll('\\', '/'))).join('\n') : '';
    const instructionText = 'Текущий профиль задачи: ' + profile.name + ' · ' + (profile.directory || '.') +
      '\nИспользуй актуальные инструкции этого запуска для указанных папок.\n' + instructionsPrompt(instructionSnapshot)
      + (chat.mode === 'code' && instructionSnapshot.sources?.some(file => file.text)
        ? '\nПеред завершением сверь изменённые файлы с применимыми требованиями, включая поведение и соглашения о коде.' : '');
    if (chat.mode === 'discuss') {
      const history = store.db.prepare("SELECT role,text FROM messages WHERE chatId=? AND id>? AND id<? AND text<>'' ORDER BY id DESC LIMIT 24")
        .all(chatId, chat.summary?.through ?? 0, message.id - 1).reverse().map(item => ({ role: item.role, content: item.text.slice(-12000) }));
      const provider = taskProvider();
      await discuss({ root: chat.cwd, provider, model: provider.model(credentials.folderId, model.id), folderId: credentials.folderId,
        history,
        prompt: [instructionText, summaryPrompt(chat.summary), text, referenceCatalog, ...context.map(contextPrompt), ...attachments.prompt(chatId, external)].join('\n\n'),
        signal: turn.abort.signal,
        readAttachment: path => attachments.read(chatId, turn.attachments, path),
        onText: text => { message.text += (message.text ? '\n\n' : '') + text; publishTurn(turn); },
        onTool: tool => { turn.tools.set(tool.id, { ...tool }); publishTurn(turn); },
      });
      return;
    }
    if (chat.planning && !resume) {
      turn.stage = 'plan'; task.status = 'planning'; publishTurn(turn); emit('app:state', snapshot());
      const draft = chat.draftPlan?.source === text ? chat.draftPlan
        : await generatePlan(taskProvider(), createProvider(credentials).model(credentials.folderId, model.id), credentials.folderId, text, instructionSnapshot, turn.abort.signal);
      task.steps = validatePlan(draft.steps); task.status = 'running';
      store.setDraftPlan(chatId, null); publishTurn(turn);
    }
    if (turn.stop) return;
    turn.stage = 'agent'; emit('app:state', snapshot());
    if (runtime && runtime.modelId !== model.id) closeRuntime();
    runtime ??= await startRuntime(join(app.getPath('userData'), 'agent'), credentials, model, requestObserver());
    if (turn.stop) return;
    turn.client = new AcpClient(chat.cwd, { ...runtime, env: { ...runtime.env, ...(commandEnv ? Object.fromEntries(Object.entries(commandEnv).filter(([key]) => key.toLowerCase() === 'path')) : {}) } }, {
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
    const discussion = store.db.prepare("SELECT text FROM messages WHERE chatId=? AND id>? AND mode='discuss' AND role='assistant' AND status='done' ORDER BY id DESC LIMIT 1").get(chatId, chat.summary?.through ?? 0)?.text;
    const common = [instructionText, summaryPrompt(chat.summary), commandsPrompt(profile, chat.cwd), referenceCatalog, ...(discussion ? ['Предыдущее обсуждение в этом чате (справочный контекст):\n' + discussion.slice(-20000)] : []), ...context.map(contextPrompt), ...attachments.prompt(chatId, external)];
    const run = async text => {
      const length = message.text.length, count = turn.tools.size;
      const result = await turn.client.request('session/prompt', { sessionId: turn.sessionId,
        prompt: [text, ...common].filter(Boolean).map(text => ({ type: 'text', text })) }, 240000);
      if (result.stopReason === 'cancelled') turn.stop = true;
      if (!turn.stop && message.text.length === length && turn.tools.size === count) throw new Error('Алиса вернула пустой ответ.');
      if (result.stopReason && !['end_turn', 'cancelled'].includes(result.stopReason)) throw new Error(`Grok Build завершил задачу со статусом ${result.stopReason}.`);
    };
    if (!task.steps.length) await run(text);
    else for (const [index, step] of task.steps.entries()) {
      if (turn.stop) break;
      if (step.status === 'done') continue;
      step.status = 'running'; delete step.note; delete step.evidence; publishTurn(turn);
      const before = new Set(turn.tools.keys());
      message.text += `\n\n### Шаг ${index + 1}. ${step.title}\n\n`;
      await run('Задача: ' + task.source + '\nПлан: ' + task.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('\n')
        + `\nВыполни сейчас только шаг ${index + 1}: ${step.title}. Дождись завершения команд. Сообщи фактический результат. `
        + (step.kind === 'test' ? 'Обязательно запусти тесты и дождись их кода выхода; не выдавай предположение за выполненную проверку.' : 'Не переходи к следующему шагу самостоятельно. Приложение продолжит план автоматически; подтверждение пользователя для перехода не запрашивай.'));
      if (turn.stop) { step.status = 'stopped'; publishTurn(turn); break; }
      const actions = [...turn.tools.values()].filter(tool => !before.has(tool.id));
      if (!finishStep(step, actions, turn.stop ? 'Остановлено пользователем.' : null)) throw new Error(step.note);
      publishTurn(turn);
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
    turn.replayProfile = store.command('agent:' + messageId + ':' + toolId)?.profile;
    turn.checkVersions = new Map([[tool.id, await commands.fingerprint(chat.cwd,turn.replayProfile)]]);
    const { error, ...result } = await runTest(details, turn.abort.signal);
    Object.assign(tool, result, { status: error ? 'failed' : 'completed', tests: nodeTestCounts(result.output),
      repeatable: !result.interrupted && Number.isInteger(result.exitCode) });
    if (error && !turn.stop) message.error = error;
  } catch (error) {
    tool.status = 'failed';
    if (!turn.stop) message.error = error.message;
  } finally {
    commands.recordAgent(turn, tool);
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
  const row = store.db.prepare('SELECT task FROM messages WHERE id=? AND chatId=?').get(messageId, chatId);
  const root = row?.task ? JSON.parse(row.task).root : store.chat(chatId).projectCwd;
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
    commands = new CommandRuns(store, run => emit('command:run', run));
    const affected = new AffectedChecks(store, commands);
    attachments = await Attachments.open(join(app.getPath('userData'), 'context-files'));
    attachments.drafts = new Map(store.draftFiles().map(([id, files]) => [id, new Map(files.map(file => [file.id, file]))]));
    attachments.persistDraft = (id, files) => store.saveDraftFiles(id, files);
    await removeLocalSessions();
    try { await importCredentials(); } catch (error) { credentialError = error.message; }
    bind('app:state', snapshot);
    bind('code:config', id => {
      const chat = store.chat(id);
      return profileConfig(chat.cwd,commandProfile(store.selectedProfile(chat)));
    });
    bind('code:query', async (id, action, input = {}) => {
      if (!['diagnostics', 'definition', 'references', 'symbols'].includes(action)) throw new Error('Неизвестное действие анализа.');
      const chat = store.chat(id), root = chat.cwd, profile = commandProfile(store.selectedProfile(chat));
      const key = JSON.stringify([id, root, profile.id, profile.directory, profile.config]);
      watchAnalysis(root); const version = revisions.get(root) ?? 0;
      const result = await codeQuery(root, action, input, profile);
      if (action === 'diagnostics') {
        const data = { ...result, key, chatId:id, root, checkedAt: Date.now(), stale: (revisions.get(root) ?? 0) !== version, overlays: (input.overlays ?? []).map(file => file.path) };
        store.saveAnalysis(key, data); emit('analysis:result', data); return data;
      }
      return result;
    });
    bind('code:stale', id => staleAnalysis(selectedPath(id)));
    bind('context:details', async (id, refs = [], externalIds = [], file = null, query = '') => {
      const chat = store.chat(id), profile = commandProfile(store.selectedProfile(chat));
      const instructions = await profileInstructions(chat.cwd,profile);
      const config = await profileConfig(chat.cwd,profile).catch(error => error.message);
      const pins = await inspectFragments(chat.cwd, chat.pins);
      const drafts = await inspectFragments(chat.cwd, refs);
      const external = attachments.files(id, externalIds).map(({ text, ...item }) => ({ ...item, chars: text.length }));
      return { root: chat.cwd, profile, config, instructions, summary: chat.summary, pins, drafts, external,
        references: store.externalAttachments(id).slice(-32), suggestions: await suggestContext(chat.cwd, file, query),
        chars: instructions.sources.reduce((sum,file) => sum + file.text.length, 0) + (chat.summary?.text.length ?? 0) + [...pins, ...drafts.filter(ref => !pins.some(pin => pin.digest === ref.digest))].reduce((sum, item) => sum + (item.chars ?? 0), 0) + external.reduce((sum, item) => sum + item.chars, 0) };
    });
    bind('context:pin', async (id, ref) => {
      const chat = store.chat(id), [valid] = await resolveContext(chat.cwd, [ref]);
      const { content, ...pin } = valid;
      const pins = chat.pins.filter(item => item.path !== pin.path || item.start !== pin.start || item.end !== pin.end);
      if (pins.length >= 6) throw new Error('Можно закрепить до 6 фрагментов.');
      pins.push(pin); store.savePins(id, pins); return snapshot();
    });
    bind('context:unpin', (id, index) => {
      const chat = store.chat(id); if (!Number.isInteger(index) || index < 0 || index >= chat.pins.length) throw new Error('Фрагмент не найден.');
      store.savePins(id, chat.pins.filter((_item, position) => position !== index)); return snapshot();
    });
    bind('context:refresh', async (id, index) => {
      const chat = store.chat(id), pin = chat.pins[index]; if (!pin) throw new Error('Фрагмент не найден.');
      const { content, ...fresh } = await previewContext(chat.cwd, pin.path, pin.start, pin.end);
      chat.pins[index] = fresh; store.savePins(id, chat.pins); return snapshot();
    });
    bind('context:compress', id => mutateState(async () => {
      if (!credentials) throw new Error('Настройте подключение к Yandex.');
      const chat = store.chat(id), model = available.find(item => item.id === chat.modelId);
      if (!model) throw new Error('Выберите доступную модель.');
      // Read this chat explicitly; compression must not depend on which chat is currently selected.
      const rows = store.db.prepare('SELECT * FROM messages WHERE chatId=? AND id>? ORDER BY id DESC LIMIT 80').all(id, chat.summary?.through ?? 0).reverse()
        .map(row => ({ ...row, tools: JSON.parse(row.tools), task: row.task ? JSON.parse(row.task) : null }));
      if (!rows.length) throw new Error('Нет новых сообщений для сжатия.');
      const first = store.db.prepare("SELECT * FROM messages WHERE chatId=? AND id>? AND role='user' ORDER BY id LIMIT 1").get(id, chat.summary?.through ?? 0);
      if (first && rows[0].id !== first.id) rows.unshift({ ...first, tools: JSON.parse(first.tools), task: first.task ? JSON.parse(first.task) : null });
      compression = new AbortController();
      try {
        const provider = taskProvider({ chatId: id, kind: 'summary' });
        const text = await summarize(provider, provider.model(credentials.folderId, model.id), credentials.folderId, rows, chat.summary, compression.signal);
        store.saveSummary(id, text, rows.at(-1).id, chat.cwd, chat.summary?.id ?? null); closeRuntime();
      } finally { compression = null; }
    }));
    bind('context:cancel', () => compression?.abort());
    bind('context:save-summary', (id, text, expected) => mutateState(() => {
      const chat = store.chat(id);
      const through = chat.summary?.through ?? Number(store.db.prepare('SELECT MAX(id) AS id FROM messages WHERE chatId=?').get(id).id ?? 0);
      store.saveSummary(id, text, through, chat.cwd, expected); closeRuntime();
    }));
    const taskChat = id => {
      const chat = store.chat(id);
      if (chat.archivedAt) throw new Error('Восстановите чат из архива.');
      return chat;
    };
    const workspaceHome = join(app.getPath('userData'), 'task-workspaces');
    const registryWorkspace = id => {
      const workspace = store.taskWorkspaces().find(item => item.id === id);
      if (!workspace) throw new Error('Рабочая папка задачи не найдена.');
      return workspace;
    };
    const assertWorkspaceStopped = workspace => {
      if (active?.cwd === workspace.root || commands.batches.has(workspace.chatId) || [...commands.active.values()].some(entry => entry.run.root === workspace.root)) throw new Error('Сначала остановите задачу и команды в этой рабочей папке.');
      if (store.workspaceStates('editor')[workspace.id]?.files?.some(file => file.dirty)) throw new Error('В редакторе задачи есть несохранённые файлы. Сохраните их перед очисткой.');
    };
    const editableProfiles = id => {
      const chat = taskChat(id);
      if (active && store.chat(active.chatId).projectId === chat.projectId) throw new Error('Завершите задачу перед изменением команд.');
      if ([...commands.batches.keys()].some(chatId => store.chat(chatId).projectId === chat.projectId)) throw Error('Дождитесь завершения проверки пакетов.');
      return chat;
    };
    bind('project:commands', (id, value) => {
      const chat = editableProfiles(id), prior = store.profiles(chat.projectId).find(p => p.id === value.id);
      store.putProfile(chat, commandProfile({ ...value, links: prior?.links })); return snapshot();
    });
    const discover = async chat => {
      const local = localProfiles(store,chat.projectId);
      const profiles = await discoverProfiles(chat.projectCwd,local);
      return { profiles, local, token: fingerprint(JSON.stringify([profiles,local])) };
    };
    bind('profiles:discover', id => discover(store.chat(id)));
    bind('profiles:adopt', (id, ids, token) => mutateState(async () => {
      const chat = editableProfiles(id), preview = await discover(chat);
      if (preview.token !== token) throw Error('Настройки пакетов изменились. Повторите поиск.');
      const selected = preview.profiles.filter(p => ids.includes(p.id));
      if (!selected.length || selected.length !== ids.length) throw Error('Выберите найденные пакеты.');
      store.importProfiles(chat.projectId,selected,false);
    }));
    bind('profiles:compare', id => {
      const chat = store.chat(id);
      watchAnalysis(chat.projectCwd);
      return repositoryProfiles(store,chat);
    });
    bind('profiles:sync', (id, direction, token) => mutateState(async () => {
      const chat = editableProfiles(id);
      if (direction === 'save') return saveRepositoryProfiles(store,chat,token);
      const current = await repositoryProfiles(store,chat);
      if (direction !== 'load' || current.repo === null || current.token !== token) throw Error('Конфигурация изменилась. Откройте сравнение заново.');
      store.importProfiles(chat.projectId,current.repo,true);
    }));
    bind('command:profile', (id, profileId) => {
      taskChat(id); if (active?.chatId === id || workspaceMutation) throw Error('Дождитесь завершения текущей операции.');
      store.selectProfile(id, profileId); return snapshot();
    });
    bind('command:start', async (id, key, original = false) => {
      const chat = taskChat(id);
      const details = { chatId: id, projectId: chat.projectId, root: original ? chat.projectCwd : chat.cwd, profile: store.selectedProfile(chat), key };
      return key === 'sequence' ? commands.sequence(details) : commands.start(details);
    });
    bind('checks:affected', id => {
      const chat = store.chat(id);
      watchAnalysis(chat.cwd);
      return affected.summary(chat);
    });
    bind('checks:run-affected', (id, ids) => affected.run(taskChat(id), ids));
    bind('checks:repair', async (id, failedId) => {
      assertIdle();
      const chat = taskChat(id), run = store.command(failedId);
      if (chat.mode !== 'code') throw Error('Выберите режим «Изменить код».');
      if (!run || run.chatId !== id || run.root !== chat.cwd || run.status !== 'failed') throw Error('Выберите ошибку в рабочей папке чата.');
      const { rows } = await affected.summary(chat, run.profile.id);
      const row = rows.find(item => item.failure === failedId && item.status === 'failed');
      if (!row || commands.batches.has(id)) throw Error('Повторите проверку на текущем коде.');
      const profile = store.profiles(chat.projectId).map(commandProfile).find(item => item.id === row.id);
      const config = await profileConfig(chat.cwd, profile);
      const prompt = ['Исправь ошибку проверки в пакете «' + profile.name + '». Примени корневые инструкции и правила пакета. Внеси минимальную правку в его исходники, сохрани существующие комментарии и публичный интерфейс. Перед ответом просмотри diff и сверь его с обоими наборами инструкций.',
        'Рабочая папка: ' + run.cwd, 'Конфигурация: ' + (config || 'по умолчанию'), 'Команда: ' + run.command,
        'Первая ошибка: ' + row.problem.text, 'Вывод проверки:\n' + run.output.slice(-12000)].join('\n');
      return send(id, prompt, [], [], null, [], profile);
    });
    bind('command:stop', id => {
      const run = store.command(id); if (!run) throw new Error('Команда не найдена.');
      if (run.source === 'agent') {
        if (active?.message.id !== run.messageId) throw new Error('Этот запуск агента уже завершён.');
        stop();
      } else commands.stop(id);
    });
    bind('command:repeat', async id => {
      const run = store.command(id); if (!run || ['pending', 'in_progress', 'background'].includes(run.status)) throw new Error('Команда ещё выполняется.');
      const chat = taskChat(run.chatId);
      const root = await realpath(run.root);
      if (run.steps) return commands.sequence({ chatId: chat.id, projectId: chat.projectId, root, profile: run.profile });
      const cwd = relative(root, await realpath(run.cwd)).replaceAll('\\', '/');
      return commands.start({ chatId: chat.id, projectId: chat.projectId, root, cwd: cwd || '.', command: run.command, key: run.check, profile: run.profile ?? store.profile(chat.projectId) });
    });
    bind('workspace:list', async () => Promise.all(store.taskWorkspaces().map(async workspace => {
      try {
        const details = await taskWorkspaceDetails(workspace, workspaceHome);
        if (active?.cwd === workspace.root || commands.batches.has(workspace.chatId) || [...commands.active.values()].some(entry => entry.run.root === workspace.root)) return { ...details, removable: false, note: 'В этой папке выполняется задача или команда.' };
        return details;
      } catch (error) { return { ...workspace, removable: false, note: error.message }; }
    })));
    bind('workspace:remove', id => mutateState(async () => {
      const workspace = registryWorkspace(id); assertWorkspaceStopped(workspace);
      const removed = await removeTaskWorkspace(workspace, workspaceHome);
      store.saveTaskWorkspace(id, workspace.projectId, workspace.chatId, removed);
    }));
    bind('workspace:reveal', async id => {
      const workspace = registryWorkspace(id); const location = await realpath(workspace.directory);
      if (relative(await realpath(workspaceHome), dirname(location)) || location !== workspace.directory) throw new Error('Папка задачи перемещена.');
      return shell.openPath(location);
    });
    bind('task:options', (id, value) => {
      if (active?.chatId === id) throw new Error('Завершите задачу перед сменой режима.');
      taskChat(id); store.setTaskOptions(id, value); return snapshot();
    });
    const instructionFile = (id,path = 'AGENTS.md') => {
      const chat = store.chat(id), profile = commandProfile(store.selectedProfile(chat));
      const local = join(profile.directory,'AGENTS.md').replaceAll('\\','/');
      if (path !== 'AGENTS.md' && path !== local) throw Error('Файл инструкций относится к другому профилю.');
      return {root:chat.cwd,path};
    };
    bind('project:instructions', (id,path) => { const file=instructionFile(id,path); return projectInstructions(file.root,file.path); });
    bind('project:save-instructions', (id,text,stamp,path) => mutateWorkspace(() => {
      const file=instructionFile(id,path); return saveInstructions(file.root,text,stamp,file.path);
    }));
    bind('task:plan', (id, input, steps = null) => mutateState(async () => {
      const chat = taskChat(id);
      const text = typeof input === 'string' ? input.trim() : '';
      if (!text || text.length > 40000) throw new Error('Введите задачу до 40 000 символов.');
      let plan;
      if (steps) plan = { source: text, steps: validatePlan(steps) };
      else {
        if (!credentials) throw new Error('Настройте подключение к Yandex.');
        const model = available.find(m => m.id === chat.modelId);
        if (!model) throw new Error('Выберите доступную модель.');
        const provider = taskProvider({ chatId: id, kind: 'plan' });
        plan = await generatePlan(provider, provider.model(credentials.folderId, model.id), credentials.folderId, text, await profileInstructions(chat.cwd,commandProfile(store.selectedProfile(chat))), new AbortController().signal);
      }
      store.setDraftPlan(id, plan);
      store.setTaskOptions(id, { approval: chat.approval, planning: true });
    }));
    bind('task:workspace', (id, branch) => mutateState(async () => {
      const chat = taskChat(id);
      if (chat.workspace) throw new Error('У этого чата уже есть отдельная ветка.');
      if (chat.sessionId || store.db.prepare("SELECT 1 FROM messages WHERE chatId=? AND mode='code' AND tools<>'[]'").get(id)) throw new Error('Создайте новый чат для отдельной ветки: предыдущие действия привязаны к исходной папке.');
      const workspace = await createTaskWorkspace(chat.cwd, join(app.getPath('userData'), 'task-workspaces'), id, branch);
      store.setTaskWorkspace(id, workspace);
    }));
    bind('task:transfer-preview', async id => {
      const result = await transferPreview(taskChat(id).workspace);
      return { token: result.token, conflict: result.conflict, files: result.files.map(({ path, patch, conflict, current, text, desired, base, resolvable }) => ({ path, patch, conflict, current: current?.text, desired, base, merged: text, resolvable, changed: !conflict && current?.text !== text })) };
    });
    bind('task:transfer', (id, token, selection = null, resolutions = {}) => mutateWorkspace(async () => {
      const chat = taskChat(id), workspace = chat.workspace;
      const before = await transferPreview(workspace);
      const files = await applyTransfer(workspace, token, selection, resolutions);
      const transferred = { ...workspace.transferred };
      for (const file of before.files.filter(file => !selection || selection.includes(file.path))) if (file.desiredStamp !== undefined) transferred[file.path] = file.desiredStamp;
      store.saveTaskWorkspace(id, chat.projectId, id, { ...workspace, transferred, transferredAt: Date.now() });
      return files;
    }));
    bind('task:resume', (id, messageId) => {
      const task = store.task(id, messageId);
      if (taskChat(id).mode !== 'code') throw new Error('Переключите чат в режим «Изменить код», чтобы продолжить план.');
      if (task.root !== taskChat(id).cwd || !task.steps.some(step => step.status !== 'done')) throw new Error('Нет незавершённых шагов в этой рабочей папке.');
      return send(id, 'Продолжи незавершённые шаги сохранённого плана.', [], [], task);
    });
    bind('app:copy', value => { if (typeof value === 'string' && value.length <= 200000) clipboard.writeText(value); });
    bind('app:open-external', url => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Недопустимый адрес.');
      return shell.openExternal(new URL(url).href);
    });
    bind('workspace:save', (scope, id, value) => store.saveWorkspace(scope, id, value));
    ipcMain.on('workspace:flush', (event, values) => {
      try {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Неподдерживаемый источник запроса.');
        store.transaction(() => { for (const [scope, id, value] of values.slice(0, 2)) store.saveWorkspace(scope, id, value); });
        event.returnValue = { ok: true };
      } catch (error) { event.returnValue = { error: error.message }; }
    });
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
      const existing = store.db.prepare('SELECT id FROM projects WHERE path=?').get(path);
      const chat = store.addProject(basename(path) || path, path);
      if (!existing) {
        try {
          const { repo } = await repositoryProfiles(store,chat);
          if (repo !== null) store.importProfiles(chat.projectId,repo,true);
        } catch (error) { return { ...snapshot(), profileNotice: error.message }; }
      }
      return snapshot();
    });
    bind('project:reveal', chatId => shell.openPath(selectedPath(chatId)));
    bind('project:inspect', async chatId => ({ changes: await listChanges(selectedPath(chatId)) }));
    bind('project:directory', (chatId, path) => listDirectory(selectedPath(chatId), path));
    bind('project:search-files', (chatId, query) => searchFiles(selectedPath(chatId), query));
    bind('project:search-content', (chatId, query) => searchContent(selectedPath(chatId), query));
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
    bind('review:add', (chatId, ...args) => {
      store.addNote(chatId, ...args);
      return snapshot();
    });
    bind('review:resolve', (chatId, id, resolved) => {
      store.db.prepare('UPDATE review_notes SET resolved=? WHERE chatId=? AND id=?').run(Number(Boolean(resolved)), chatId, id);
      return snapshot();
    });
    bind('review:send', async chatId => {
      const notes = store.notes(chatId).filter(note => !note.reply && !note.resolved);
      if (!notes.length) throw Error('Нет новых замечаний.');
      if (store.chat(chatId).mode !== 'code') throw Error('Выберите режим «Изменить код».');
      const prompt = ['Доработай код по замечаниям ревью и проверь результат.', ...notes.map(note =>
        note.path + ':' + note.anchor.start + '–' + note.anchor.end + (note.anchor.side === 'old' ? ' (удалено)' : '') +
        '\nФрагмент:\n' + note.anchor.snippet + '\nЗамечание: ' + note.body)].join('\n\n');
      await send(chatId, prompt, [], [], null, notes.map(note => note.id));
    });
    bind('checks:version', async (chatId, original, runId) => {
      const chat = store.chat(chatId), root = original ? chat.projectCwd : chat.cwd;
      watchAnalysis(root);
      if (!runId) return codeVersion(root);
      const run = store.command(runId);
      if (run?.chatId !== chatId || run.root !== root) return null;
      const now = await fileRevision(root,run.profile?.scope);
      if (!now) return null;
      let changed;
      if (now.version !== run.version) {
        const saved = store.db.prepare('SELECT files FROM check_files WHERE version=?').get(run.version);
        if (saved) {
          const prior = new Map(JSON.parse(saved.files)), current = new Map(now.files);
          changed = [...new Set([...prior.keys(), ...current.keys()])].find(path => prior.get(path) !== current.get(path));
        }
      }
      return { version: now.version, changed };
    });
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
      if (active?.chatId === id || workspaceMutation || commands.batches.has(id) || [...commands.active.values()].some(entry => entry.run.chatId === id)) throw new Error('Завершите текущую операцию и команды перед удалением.');
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
    bind('chat:mode', (id, mode) => {
      if (active?.chatId === id) throw new Error('Смените режим после завершения ответа.');
      if (store.chat(id).archivedAt) throw new Error('Восстановите чат из архива.');
      store.setMode(id, mode);
      return snapshot();
    });
    bind('history:search', (query, includeArchived) => store.search(query, includeArchived));
    bind('settings:layout', value => store.set('layout', JSON.stringify(normalizeLayout(value))));
    bind('settings:models', refreshModels);
    bind('settings:check-provider', checkConnection);
    bind('chat:send', (id, text, refs, external) => send(id, text, refs, external));
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
let stoppingCommands = false;
app.on('before-quit', event => {
  compression?.abort();
  if ((commands?.active.size || commands?.batches.size) && !stoppingCommands) {
    event.preventDefault(); stoppingCommands = true;
    void commands.close().finally(() => app.quit());
    return;
  }
  if (active) {
    active.stop = true;
    active.abort?.abort();
    clearTimeout(active.refresh);
    clearTimeout(active.stopTimer);
    cancelPermissions(active);
    active.client?.close();
    active.message.status = 'cancelled';
    if (active.message.task) {
      active.message.task.status = 'stopped';
      for (const step of active.message.task.steps) if (step.status === 'running') step.status = 'stopped';
    }
    publishTurn(active);
  }
  closeRuntime();
  for (const watcher of analysisWatchers.values()) watcher.close();
});
