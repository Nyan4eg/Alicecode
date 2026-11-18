'use strict';

const api = window.alicecode;
const $ = id => document.getElementById(id);
const statusLabels = {
  pending: 'Ожидает', in_progress: 'Выполняется', completed: 'Готово', failed: 'Ошибка',
};
const drafts = new Map();
const draftContexts = new Map();
const externalDrafts = new Map();
const openTools = new Set();
const expandedFolders = new Set();
const folderLimits = new Map();
const folders = new Map();
let state;
let workspace;
let workspaceRequest = 0;
let tab = 'files';
let review;
let preview;
let previewRequest = 0;
let permissionId;
let createParent;
let toastTimer;
let layout;
let renameTarget;
let searchTimer;
let searchRequest = 0;
let searchResults = [];
let selectedResult = -1;
let searchHit = null;
let filePicker;
let fileTimer;
let contextTimer;
let replayTarget;
let sending = false;
const openArchives = new Set();
const editorFiles = new Map();
let editView;
let editor;
let editorConflict;
let editorRequest = 0;
let chatAction;
let rollbackTarget;
let stageTarget;
let commitTarget;
let attachmentSelection;
let attachmentBusy = false;
const chatViews = new Map();
let workspaceTimer;
let restoringWorkspace = false;
let restoreGeneration = 0;
let contentTimer;
let contentRequest = 0;
let instructionsTarget;
let planTarget;
let transferTarget;
const providerLabels = { key: 'AI Studio по API-ключу', subscription: 'Yandex Cloud по подписке' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setText(id, text) {
  const node = $(id);
  node.textContent = text;
  return node;
}

function errorText(error) {
  return String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function toast(error) {
  const node = setText('global-error', errorText(error));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}

function activeChat() {
  return state?.chats.find(chat => chat.id === state.activeChat);
}

function renameButton(kind, item) {
  const button = element('button', 'quiet rename-item', '✎');
  button.type = 'button';
  button.title = kind === 'project' ? 'Переименовать проект · Shift+F2' : 'Переименовать чат · F2';
  button.setAttribute('aria-label', `${button.title.split(' · ')[0]} «${item.title}»`);
  button.addEventListener('click', () => openRename(kind, item));
  return button;
}

function renderNavigation() {
  const tree = $('projects');
  tree.replaceChildren();
  for (const project of state.projects) {
    const group = element('div', 'project-group');
    const title = element('button', 'project-item');
    const icon = element('span', '', '▱');
    icon.setAttribute('aria-hidden', 'true');
    title.append(icon, document.createTextNode(project.title));
    title.title = project.path;
    const chats = state.chats.filter(chat => chat.projectId === project.id);
    title.addEventListener('click', () => selectProject(project.id));
    const projectRow = element('div', 'nav-row');
    projectRow.append(title, renameButton('project', project));
    group.append(projectRow);
    function chatRow(chat) {
      const item = element('button', 'chat-item', chat.title);
      item.title = chat.title;
      item.setAttribute('aria-current', String(chat.id === state.activeChat));
      if (state.busy === chat.id) {
        const waiting = state.permission?.chatId === chat.id;
        const badge = element('span', `chat-task ${waiting ? 'waiting' : ''}`, waiting ? 'Разрешение' : 'В работе');
        item.append(badge);
      }
      item.addEventListener('click', () => select(chat.id));
      const actions = element('button', 'quiet rename-item chat-actions-button', '⋯');
      actions.type = 'button';
      actions.title = 'Действия с чатом';
      actions.setAttribute('aria-label', 'Действия с чатом «' + chat.title + '»');
      actions.addEventListener('click', () => openChatActions(chat));
      const row = element('div', 'nav-row chat-row');
      row.append(item, actions);
      return row;
    }
    for (const chat of chats.filter(item => !item.archivedAt)) group.append(chatRow(chat));
    const archived = chats.filter(item => item.archivedAt);
    if (archived.length) {
      const archive = element('details', 'archive-group');
      archive.open = openArchives.has(project.id) || archived.some(item => item.id === state.activeChat);
      archive.addEventListener('toggle', () => {
        if (archive.open) openArchives.add(project.id);
        else openArchives.delete(project.id);
      });
      archive.append(element('summary', '', 'Архив · ' + archived.length), ...archived.map(chatRow));
      group.append(archive);
    }
    tree.append(group);
  }
}

function findReference(value, paths) {
  if (!value) return;
  let normalized = value.trim();
  try { normalized = decodeURIComponent(value); } catch {}
  const suffix = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L\d+)?)$/i.exec(normalized);
  const line = suffix ? Number(suffix[1] ?? suffix[2]) : null;
  if (suffix) normalized = normalized.slice(0, suffix.index);
  if (/^[a-z]+:\/\//i.test(normalized) && !normalized.startsWith('file:///')) return;
  normalized = normalized.replaceAll('\\', '/').replace(/^file:\/\/\//i, '')
    .replace(/^\/(?=[a-z]:\/)/i, '').replace(/^\.\//, '');
  const project = state.projects.find(item => item.id === activeChat()?.projectId);
  const root = project && project.path.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase())) normalized = normalized.slice(root.length);
  const direct = paths.find(path => path.toLowerCase() === normalized.toLowerCase());
  if (direct) return { path: direct, line };
  if (normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').includes('..')) return;
  const matches = paths.filter(path => path.toLowerCase().split('/').at(-1) === normalized.toLowerCase());
  if (matches.length === 1) return { path: matches[0], line };
  if ((line || value.includes('/')) && /(?:^|\/)[^/]+\.[a-z0-9_-]{1,16}$/i.test(normalized)) return { path: normalized, line };
}

function fileLink(path, label = path, options = {}) {
  const button = element('button', 'file-link', label);
  button.type = 'button';
  button.title = path;
  button.addEventListener('click', () => openPreview(path, options.mode ?? 'files', options));
  return button;
}

function formatMessage(text, paths = []) {
  return window.aliceMarkdown.render(text, {
    fileReference: (value, label) => {
      const ref = findReference(value, paths) ?? (label && findReference(label, paths));
      return ref ? fileLink(ref.path, label ?? value, ref) : null;
    },
    copyText: api.copyText, openExternal: url => api.openExternal(url).catch(toast),
  });
}

function actionOutcome(tool) {
  if (tool.decision === 'denied') return ['Отклонено', 'failed'];
  if (tool.interrupted) return ['Прервано', 'failed'];
  if (tool.local && tool.status === 'in_progress' && state.busyStage === 'prepare') return ['Подготовка', 'neutral'];
  if (tool.background) return ['В фоне', 'neutral'];
  if (tool.status === 'completed' || tool.status === 'failed') {
    if (Number.isInteger(tool.exitCode)) {
      return tool.exitCode === 0 ? ['Код 0', 'success'] : [`Код ${tool.exitCode} · ошибка`, 'failed'];
    }
    if (tool.status === 'completed' && executedCommand(tool)) return ['Без кода выхода', 'neutral'];
  }
  return [statusLabels[tool.status] ?? 'Ожидает', tool.status === 'failed' ? 'failed' : 'neutral'];
}

function executedCommand(tool) {
  return tool.command ?? (tool.kind === 'execute' ? /^Execute `(.+)`$/s.exec(tool.title)?.[1] : undefined);
}

function workSummary(message, paths) {
  const panel = element('section', 'work-summary');
  panel.setAttribute('aria-label', 'Ход работы');
  const tools = message.tools.map(tool => message.status === 'cancelled' && ['pending', 'in_progress'].includes(tool.status)
    ? { ...tool, interrupted: true } : tool);
  const commands = tools.filter(executedCommand);
  const testRuns = commands.filter(tool => tool.local || tool.tests || tool.repeatable
    || /\b(?:node\s+--test|npm\s+(?:run\s+)?test|pytest|vitest|jest|cargo\s+test|go\s+test)\b/.test(executedCommand(tool)));
  const head = element('div', 'work-heading');
  head.append(element('strong', '', 'Ход работы'));
  head.append(element('span', 'work-meta',
    [paths.length && `Файлы · ${paths.length}`, commands.length && `Команды · ${commands.length}`].filter(Boolean).join('  /  ')));
  panel.append(head);
  if (testRuns.length) {
    const runs = element('ol', 'test-runs');
    for (const [index, tool] of testRuns.entries()) {
      const [label, tone] = actionOutcome(tool);
      const row = element('li', 'test-run');
      row.append(element('span', 'run-index', String(index + 1)), element('code', '', executedCommand(tool)));
      if (tool.tests) {
        row.append(element('span', 'test-counts', `Прошло ${tool.tests.passed} из ${tool.tests.total}`
          + (tool.tests.failed ? ` · ошибок ${tool.tests.failed}` : '')));
      }
      if (Number.isFinite(tool.elapsedMs)) row.append(element('span', 'test-duration',
        `${(tool.elapsedMs / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`));
      row.append(element('span', `outcome ${tone}`, label));
      if (tool.repeatable && message.status !== 'running') {
        const repeat = element('button', 'quiet', 'Повторить');
        repeat.type = 'button';
        repeat.disabled = Boolean(state.busy || state.workspaceMutation || activeChat()?.archivedAt);
        repeat.addEventListener('click', () => confirmReplay(message, tool));
        row.append(repeat);
      }
      runs.append(row);
    }
    panel.append(runs);
  }
  if (paths.length) {
    const files = element('div', 'work-files');
    for (const path of paths) {
      if (message.review?.files.some(item => item.path === path)) {
        const link = element('button', 'file-link', path);
        link.type = 'button';
        link.addEventListener('click', () => openReview(message, path));
        files.append(link);
      } else files.append(fileLink(path, path, { mode: 'changes' }));
    }
    panel.append(files);
  }
  if (message.review) {
    const { files, note, skipped } = message.review;
    if (files.length) {
      const show = element('button', 'quiet review-button', `Изменения за запуск · ${files.length}`);
      show.type = 'button';
      show.addEventListener('click', () => openReview(message));
      panel.append(show);
    } else if (message.review.state === 'ready') panel.append(element('p', 'work-note', 'Файлы за запуск не изменились.'));
    if (note) panel.append(element('p', 'work-note', note));
    if (skipped) panel.append(element('p', 'work-note', `Не удалось показать изменения для ${skipped} файлов.`));
  }
  if (message.managedPaths?.length && message.status !== 'running') {
    const revert = element('button', 'quiet rollback-button', 'Откатить правки…');
    revert.type = 'button';
    revert.disabled = Boolean(state.busy || state.workspaceMutation);
    revert.addEventListener('click', () => openRollback(message));
    panel.append(revert);
  }
  if (!tools.length) return panel;
  const journal = disclosure(`${message.id}:journal`, `Журнал действий · ${tools.length}`);
  if (tools.some(tool => tool.status === 'failed' || tool.exitCode > 0)) {
    journal.classList.add('journal-errors');
    journal.querySelector('summary').append(element('span', 'outcome failed', 'Есть ошибки'));
  }
  const list = element('div', 'tool-list');
  for (const tool of tools) {
    const details = disclosure(`${message.id}:${tool.id}`, executedCommand(tool) ?? tool.title);
    const [label, tone] = actionOutcome(tool);
    details.querySelector('summary').append(element('span', `outcome ${tone}`, label));
    if (tool.automatic) details.querySelector('summary').append(element('span', 'outcome auto-decision', 'Авто · Bypass'));
    if (tool.cwd || tool.repeatable) {
      const footer = element('div', 'tool-command');
      if (tool.cwd) footer.append(element('span', 'tool-directory', tool.cwd));
      if (tool.repeatable && message.status !== 'running') {
        const repeat = element('button', 'quiet', 'Повторить');
        repeat.type = 'button';
        repeat.disabled = Boolean(state.busy || state.workspaceMutation || activeChat()?.archivedAt);
        repeat.addEventListener('click', () => confirmReplay(message, tool));
        footer.append(repeat);
      }
      details.append(footer);
    }
    if (tool.output) details.append(element('pre', 'tool-output', tool.output));
    list.append(details);
  }
  journal.append(list);
  panel.append(journal);
  return panel;
}

function disclosure(key, title) {
  const details = element('details');
  details.open = openTools.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) openTools.add(key);
    else openTools.delete(key);
  });
  details.append(element('summary', '', title));
  return details;
}

function renderMessage(message) {
  const row = element('article', `message ${message.role}`);
  row.dataset.messageId = message.id;
  if (message.id === searchHit) row.classList.add('history-hit');
  if (message.role === 'user') {
    row.setAttribute('aria-label', 'Вы');
    row.append(formatMessage(message.text));
    if (message.attachments?.length) {
      const context = element('div', 'message-context');
      for (const item of message.attachments) {
        if (item.kind !== 'external') context.append(fileLink(item.path, contextLabel(item), { line: item.start }));
        else {
          const file = element('button', 'file-link', item.label);
          file.type = 'button';
          file.addEventListener('click', () => openSavedAttachment(message.chatId, item.id));
          context.append(file);
        }
      }
      row.append(context);
    }
    return row;
  }
  const role = element('div', 'message-role');
  const mark = element('span', 'mark');
  mark.setAttribute('aria-hidden', 'true');
  const local = message.tools.some(tool => tool.local);
  if (!local) role.append(mark);
  role.append(document.createTextNode(local ? 'Локальный запуск тестов' : 'Алиса'));
  if (message.modelId) role.append(element('span', 'model-label',
    state.models.find(model => model.id === message.modelId)?.label ?? message.modelId));
  if (message.mode === 'discuss') role.append(element('span', 'mode-badge', 'Обсуждение · только чтение'));
  row.append(role);
  if (message.task) row.append(renderTask(message));
  const paths = [...new Set(message.tools.filter(tool => tool.status === 'completed' && tool.decision !== 'denied')
    .flatMap(tool => tool.paths ?? []))];
  const visibleFiles = [...folders.values()].flatMap(folder => (folder.entries ?? []).filter(item => !item.directory).map(item => item.path));
  const references = [...new Set([...paths, ...visibleFiles, ...(workspace?.changes ?? []).map(item => item.path)])];
  if (message.tools.length || message.review || message.managedPaths?.length) row.append(workSummary(message, paths));
  row.append(formatMessage(message.text, references));
  if (message.error) row.append(element('p', 'error', message.error));
  if (message.status === 'cancelled') row.append(element('p', 'busy-text', 'Задача остановлена.'));
  if (message.status === 'running' && !message.text) {
    const status = { prepare: 'Проверяем рабочую папку…', review: 'Сравниваем изменения…', test: 'Выполняем тесты…' };
    row.append(element('p', 'busy-text', status[state.busyStage] ?? 'Алиса работает…'));
  }
  return row;
}

function atBottom() {
  const thread = $('thread');
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
}

function scrollBottom() {
  $('thread').scrollTop = $('thread').scrollHeight;
}

function renderThread(forceScroll) {
  const scroll = forceScroll || atBottom();
  const chat = activeChat();
  $('empty').hidden = Boolean(state.messages.length);
  setText('empty-title', chat ? 'Новый чат' : 'Начните с проекта');
  setText('empty-note', chat ? 'Опишите задачу, которую Алиса выполнит в этой папке.'
    : 'Создайте папку или откройте существующий проект.');
  $('messages').replaceChildren(...state.messages.map(renderMessage));
  if (scroll) scrollBottom();
}

function renderComposer() {
  const chat = activeChat();
  const picker = $('composer-profile'), profiles = state.profileSets?.[chat?.projectId] ?? [];
  const labels = profiles.map(p => [p.name + ' · ' + (p.directory || '.'),p.id]);
  const optionsKey = JSON.stringify(labels);
  if (picker.dataset.options !== optionsKey) {
    picker.replaceChildren(...labels.map(([label,id]) => new Option(label,id))); picker.dataset.options = optionsKey;
  }
  picker.value = chat?.profileId ?? 'all'; picker.disabled = !chat || Boolean(chat.archivedAt || state.busy || state.workspaceMutation);
  $('approval-mode').value = chat?.approval ?? 'ask';
  $('approval-mode').disabled = !chat || Boolean(chat.archivedAt) || state.busy === chat.id;
  $('use-plan').checked = Boolean(chat?.planning);
  $('use-plan').disabled = !chat || Boolean(chat.archivedAt) || state.busy === chat.id || chat.mode === 'discuss';
  $('prepare-plan').disabled = !chat || !state.configured || Boolean(state.busy || state.workspaceMutation || chat.archivedAt) || !$('prompt').value.trim();
  $('composer').classList.toggle('bypass-active', chat?.approval === 'bypass' && chat.mode === 'code');
  $('draft-plan-card').hidden = !chat?.draftPlan || !chat.planning || chat.mode === 'discuss';
  $('draft-plan-steps').replaceChildren(...(chat?.draftPlan?.steps ?? []).map(step => element('li', '', step.title)));
  $('taskbar').hidden = !chat;
  $('create-task-branch').hidden = Boolean(chat?.workspace);
  $('transfer-task').hidden = !chat?.workspace;
  for (const id of ['create-task-branch', 'transfer-task', 'project-instructions']) $(id).disabled = Boolean(state.busy || state.workspaceMutation || chat?.archivedAt);
  const location = setText('task-location', chat?.workspace ? chat.workspace.branch + ' · рабочая папка задачи' : 'Исходная папка проекта');
  location.title = chat?.workspace?.root ?? '';
  $('chat-mode').value = chat?.mode ?? 'code';
  $('chat-mode').disabled = !chat || Boolean(chat.archivedAt) || state.busy === chat.id;
  setText('mode-note', chat?.mode === 'discuss' ? 'Только чтение и поиск · без команд' : chat?.approval === 'bypass' ? 'Все действия одобряются автоматически' : 'Правки и команды — с разрешения');
  $('composer-area').hidden = !chat;
  $('archive-banner').hidden = !chat?.archivedAt;
  $('composer').hidden = Boolean(chat?.archivedAt);
  $('stop').hidden = state.busy !== chat?.id || state.busyStage === 'review';
  const permission = state.permission;
  $('permission').hidden = !permission || permission.chatId !== chat?.id;
  renderPermission($('permission').hidden ? null : permission);
  const available = state.models.some(model => model.id === (chat?.modelId ?? state.defaultModel));
  const notice = !state.configured ? state.credentialError ?? 'Выберите и настройте подключение к Yandex.'
    : chat && !available ? 'Модель отсутствует в каталоге. Выберите другую.'
    : '';
  const other = state.chats.find(item => item.id === state.busy && item.id !== chat?.id);
  const noticeNode = setText('notice', notice);
  if (other) {
    const waiting = state.permission?.chatId === other.id;
    const jump = element('button', 'quiet jump-chat', `${waiting ? 'Ждёт разрешения' : 'В работе'} · ${other.title}`);
    jump.type = 'button';
    jump.addEventListener('click', () => select(other.id));
    noticeNode.append(jump);
  }
  noticeNode.hidden = !notice && !other;
  $('prompt').disabled = !state.configured;
  const prompt = $('prompt');
  const priorHeight = prompt.style.height;
  prompt.style.height = 'auto';
  if (prompt.scrollHeight) prompt.style.height = prompt.scrollHeight + 'px';
  else prompt.style.height = priorHeight;
  $('attach-file').disabled = !chat || !state.configured || currentContext().length >= 6;
  $('attach-external').disabled = $('attach-folder').disabled = !canAttach();
  $('send').disabled = !chat || chat.archivedAt || !state.configured || !available || Boolean(state.busy || state.workspaceMutation)
    || sending || !$('prompt').value.trim();
  renderAttachments();
  if (typeof renderIntelligence === 'function') renderIntelligence();
  scheduleWorkspaceSave();
}

function renderModels() {
  const chat = activeChat();
  const current = chat?.modelId ?? state.defaultModel;
  const picker = $('model');
  picker.replaceChildren();
  for (const model of state.models) {
    const option = element('option', '', `${model.label} · ${model.badge}`);
    option.value = model.id;
    picker.append(option);
  }
  if (!state.models.some(model => model.id === current)) {
    const unavailable = element('option', '', `${current} · недоступна`);
    unavailable.value = current;
    unavailable.disabled = true;
    picker.prepend(unavailable);
  }
  picker.value = current;
  picker.disabled = !chat || Boolean(chat.archivedAt) || !state.configured || state.busy === chat.id;
  $('provider').classList.toggle('connected', state.configured);
  const selected = state.models.find(model => model.id === current);
  const time = selected?.medianSeconds?.toLocaleString('ru-RU');
  picker.title = !state.configured ? 'Подключение не настроено'
    : (providerLabels[state.providerMode] ?? '') + (time ? ` · ${selected.label}, тест 3 из 3, медиана ${time} с.` : '');
  setText('catalog-status', !state.configured ? 'Сохраните подключение, чтобы выбрать модель.'
    : state.catalogStatus === 'loading' ? 'Загружаем модели…'
      : state.catalogStatus === 'error' ? 'Каталог недоступен. Показаны поддерживаемые модели.'
        : state.catalogStatus === 'documented' ? `Моделей в подписочном каталоге Яндекса: ${state.models.length}.`
          : `Совместимых моделей в вашем каталоге: ${state.models.length}.`);
  $('refresh-models').disabled = !state.configured || state.catalogStatus === 'loading';
}

function renderPermission(permission) {
  if (permissionId === permission?.id) return;
  permissionId = permission?.id;
  if (!permission) return;
  setText('permission-title', permission.title);
  const content = $('permission-details');
  content.replaceChildren();
  $('allow').disabled = $('deny').disabled = false;
  if (permission.kind === 'command') {
    content.append(element('pre', 'permission-command', permission.command),
      element('div', 'permission-field', permission.directoryLabel),
      element('code', 'permission-path', permission.directory));
  } else if (permission.kind === 'managed-write') {
    content.append(element('code', 'permission-path', permission.path),
      element('pre', 'permission-after', permission.patch));
  } else if (permission.kind === 'edit') {
    for (const change of permission.changes) {
      const entry = element('div', 'permission-edit');
      entry.append(element('code', 'permission-path', change.path));
      if (change.before) {
        entry.append(element('div', 'permission-field', 'Было'), element('pre', 'permission-before', change.before));
      }
      if (typeof change.after === 'string') {
        entry.append(element('div', 'permission-field', 'Станет'), element('pre', 'permission-after', change.after || 'Пустой текст'));
      }
      content.append(entry);
    }
  } else {
    content.append(element('div', '', permission.action));
    if (permission.detail) {
      const details = element('details');
      details.append(element('summary', '', 'Параметры'), element('pre', '', permission.detail));
      content.append(details);
    }
  }
}

function renderUpdates() {
  const update = state.updates;
  if (!update) return;
  const labels = {
    idle: '',
    checking: 'Проверяем наличие обновлений…',
    current: 'Установлена последняя версия.',
    downloading: `Загружается ${update.nextVersion}${Number.isFinite(update.percent) ? ` · ${update.percent}%` : ''}.`,
    ready: `Версия ${update.nextVersion} готова к установке.`,
    installing: 'Приложение перезапускается…',
    error: 'Не удалось проверить или загрузить обновление. Попробуйте ещё раз.',
  };
  setText('update-status', `Версия ${update.version}. ${update.enabled
    ? labels[update.phase] : 'Автообновление доступно в установленной версии.'}`);
  $('check-updates').hidden = !update.enabled || ['ready', 'installing'].includes(update.phase);
  $('check-updates').disabled = ['checking', 'downloading'].includes(update.phase);
  $('install-update').hidden = update.phase !== 'ready';
  $('install-update').disabled = Boolean(state.busy);
}

function updateState(next) {
  if (next.profileNotice) toast(next.profileNotice);
  const previous = state;
  const previousChat = previous?.chats.find(item => item.id === previous.activeChat);
  const nextChat = next.chats.find(item => item.id === next.activeChat);
  const changed = previous?.activeChat !== next.activeChat || previousChat?.workspace?.root !== nextChat?.workspace?.root;
  if (changed && previous?.activeChat && next.chats.some(item => item.id === previous.activeChat)) persistWorkspace();
  if (!previous) {
    for (const [id, saved] of Object.entries(next.chatStates ?? {})) {
      drafts.set(id, saved.draft ?? '');
      draftContexts.set(id, saved.context ?? []);
      chatViews.set(id, saved.view ?? {});
    }
    for (const [id, files] of Object.entries(next.draftFiles ?? {})) externalDrafts.set(id, files);
    for (const [id, saved] of Object.entries(next.projectStates ?? {})) {
      editorFiles.set(id, new Map((saved.files ?? []).map(file => [file.path, file])));
    }
    for (const [id, saved] of Object.entries(next.editorStates ?? {})) editorFiles.set('task:' + id, new Map((saved.files ?? []).map(file => [file.path, file])));
  }
  if (changed && previous?.activeChat) drafts.set(previous.activeChat, $('prompt').value);
  state = next;
  if (!layout) {
    layout = { ...state.layout };
    showInspector(layout.inspectorVisible, false);
  }
  if (changed) {
    restoringWorkspace = true;
    $('prompt').value = drafts.get(state.activeChat) ?? '';
    workspace = undefined;
    folders.clear();
    const priorProject = previous?.chats.find(item => item.id === previous.activeChat)?.projectId;
    if (priorProject !== activeChat()?.projectId || previousChat?.workspace?.root !== nextChat?.workspace?.root) {
      expandedFolders.clear();
      folderLimits.clear();
    }
    hideEditor();
    review = undefined;
    if (tab === 'review') selectTab('files');
    else selectTab(tab);
    preview = undefined;
    previewRequest++;
    searchHit = null;
    renderPreview();
  }
  const chat = activeChat();
  const project = state.projects.find(item => item.id === chat?.projectId);
  setText('project-title', project?.title ?? 'Рабочее пространство').title = project?.path ?? '';
  setText('chat-title', chat?.title ?? '').title = chat?.title ?? '';
  $('new-chat').hidden = !chat;
  $('reveal').disabled = !chat;
  $('find-file').disabled = !chat;
  $('find-content').disabled = !chat;
  renderModels();
  renderNavigation();
  renderComposer();
  renderThread(changed);
  renderUpdates();
  renderEditorTabs();
  if (typeof renderWorkflow === 'function') { if (changed) restoreWorkflow(chatViews.get(state.activeChat)?.workflow); renderWorkflow(); }
  if (changed || previous?.busy && !state.busy || previous?.workspaceMutation && !state.workspaceMutation) refreshWorkspace();
  else if (!previous) renderWorkspace();
  if (changed) void restoreWorkspace(chatViews.get(state.activeChat) ?? {});
}

async function select(chatId) {
  if (!chatId || chatId === state.activeChat) return;
  try { updateState(await api.selectChat(chatId)); } catch (error) { toast(error); }
}

async function selectProject(projectId) {
  if (!projectId || (activeChat()?.projectId === projectId && !activeChat()?.archivedAt)) return;
  try { updateState(await api.selectProject(projectId)); } catch (error) { toast(error); }
}

function openRename(kind, item) {
  if (!item || $('rename-dialog').open) return;
  renameTarget = { kind, id: item.id };
  setText('rename-title', kind === 'project' ? 'Переименовать проект' : 'Переименовать чат');
  setText('rename-note', 'Меняется название в Alicecode. Папка проекта остаётся на месте.').hidden = kind !== 'project';
  $('rename-input').value = item.title;
  $('rename-error').hidden = true;
  $('rename-dialog').showModal();
  $('rename-input').focus();
  $('rename-input').select();
}

function renderSearchSelection() {
  const rows = [...$('history-results').children];
  rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === selectedResult)));
  const row = rows[selectedResult];
  if (row) {
    $('history-query').setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  } else {
    $('history-query').removeAttribute('aria-activedescendant');
  }
}

function renderSearch(results, status) {
  searchResults = results;
  selectedResult = results.length ? 0 : -1;
  setText('history-status', status);
  $('history-results').replaceChildren(...results.map((result, index) => {
    const row = element('button', 'history-result');
    row.id = `history-result-${index}`;
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    row.type = 'button';
    const kind = { project: 'Проект', chat: 'Чат', message: 'Сообщение' }[result.kind];
    const location = [kind, state.chats.find(chat => chat.id === result.chatId)?.archivedAt && 'Архив', result.kind !== 'project' && result.projectTitle,
      result.kind === 'message' && result.chatTitle].filter(Boolean).join(' · ');
    row.append(element('strong', '', result.snippet), element('small', '', location));
    row.addEventListener('click', () => openSearchResult(result));
    return row;
  }));
  renderSearchSelection();
}

function searchHistory() {
  clearTimeout(searchTimer);
  const id = ++searchRequest;
  const query = $('history-query').value.trim();
  if (!query) {
    renderSearch([], 'Ищем по всем проектам и чатам.');
    return;
  }
  renderSearch([], 'Поиск…');
  searchTimer = setTimeout(async () => {
    try {
      const results = await api.search(query, $('search-archive').checked);
      if (id !== searchRequest || !$('history-dialog').open) return;
      renderSearch(results, results.length ? '' : 'Ничего не найдено.');
    } catch (error) {
      if (id === searchRequest) renderSearch([], errorText(error));
    }
  }, 125);
}

function openSearch() {
  if (!$('history-dialog').open) $('history-dialog').showModal();
  $('history-query').focus();
  $('history-query').select();
  searchHistory();
}

async function openSearchResult(result) {
  if (!result) return;
  try {
    const next = result.chatId ? await api.selectChat(result.chatId) : await api.selectProject(result.projectId);
    $('history-dialog').close();
    updateState(next);
    searchHit = result.messageId;
    renderThread(false);
    if (searchHit) document.querySelector(`[data-message-id="${searchHit}"]`)?.scrollIntoView({ block: 'center' });
    $('prompt').focus({ preventScroll: true });
  } catch (error) { toast(error); }
}

function selectTab(next) {
  tab = next;
  $('review-tab').hidden = !review;
  for (const name of ['files', 'changes', 'review']) $(`${name}-tab`).setAttribute('aria-selected', String(tab === name));
  renderEditorTabs();
  scheduleWorkspaceSave();
}

function showInspector(visible, persist = true) {
  layout.inspectorVisible = visible;
  $('inspector').hidden = !visible;
  $('inspector-grip').hidden = !visible;
  $('toggle-inspector').setAttribute('aria-expanded', String(visible));
  renderLayout();
  if (persist) saveLayout();
}

function bounds(key) {
  if (key === 'sidebar') return [150, Math.min(420, window.innerWidth - 470)];
  const left = $('sidebar-grip').previousElementSibling.getBoundingClientRect().width;
  return [180, Math.max(180, Math.min(720, window.innerWidth - left - 304))];
}

function clampWidth(key, width) {
  const [min, max] = bounds(key);
  return Math.min(max, Math.max(min, Math.round(width)));
}

function renderLayout() {
  if (!layout) return;
  const compact = window.innerWidth <= 850;
  const medium = window.innerWidth <= 1000;
  const defaults = { sidebar: compact ? 165 : medium ? 190 : 231,
    inspector: (preview || editView) ? compact ? 280 : Math.max(340, Math.min(650, window.innerWidth * (editView ? .45 : .33)))
      : compact ? 180 : medium ? 210 : 255 };
  for (const key of ['sidebar', 'inspector']) {
    const width = clampWidth(key, layout[key] ?? defaults[key]);
    document.body.style.setProperty(`--${key}-width`, `${width}px`);
    const grip = $(`${key}-grip`);
    const [min, max] = bounds(key);
    grip.setAttribute('aria-valuenow', width);
    grip.setAttribute('aria-valuemin', min);
    grip.setAttribute('aria-valuemax', max);
  }
}

function saveLayout() {
  api.saveLayout(layout).catch(toast);
}

function bindGrip(key, direction) {
  const grip = $(`${key}-grip`);
  let start;
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !layout) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    start = { x: event.clientX, width: Number(grip.getAttribute('aria-valuenow')) };
    grip.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', event => {
    if (!start || event.clientX === start.x && layout[key] === null) return;
    layout[key] = clampWidth(key, start.width + direction * (event.clientX - start.x));
    renderLayout();
  });
  grip.addEventListener('lostpointercapture', () => {
    if (!start) return;
    start = null;
    grip.classList.remove('dragging');
    document.body.classList.remove('resizing');
    saveLayout();
  });
  grip.addEventListener('keydown', event => {
    if (!layout || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 16 : -16;
    layout[key] = clampWidth(key, Number(grip.getAttribute('aria-valuenow')) + direction * delta);
    renderLayout();
    saveLayout();
  });
  grip.addEventListener('dblclick', () => {
    if (!layout) return;
    layout[key] = null;
    renderLayout();
    saveLayout();
  });
}

function renderPreview() {
  $('inline-preview').hidden = !preview;
  $('inspector').classList.toggle('reviewing', Boolean(preview || editView));
  renderLayout();
  $('preview-nav').hidden = !preview || preview.mode === 'files' || Boolean(preview.loading || preview.error);
  $('add-review-note').hidden = preview?.mode !== 'review' || !preview.text;
  if (!preview) return;
  setText('preview-title', preview.path).title = preview.path;
  const mode = preview.mode === 'review' ? 'Изменения за запуск' : preview.mode === 'files' ? 'Файл'
    : { staged: 'В индексе Git', unstaged: 'В рабочей папке Git', all: 'Все изменения Git' }[preview.scope];
  setText('preview-mode', mode);
  $('edit-preview').hidden = preview.mode !== 'files' || Boolean(preview.loading || preview.error);
  $('attach-preview').hidden = preview.mode !== 'files' || Boolean(preview.error) || !preview.text || !state.configured;
  const change = workspace?.changes.find(item => item.path === preview.path);
  const gitScope = preview.scope;
  const canStage = preview.mode === 'changes' && Boolean(change)
    && (gitScope === 'staged' ? change.staged : change.unstaged || change.untracked);
  const busy = Boolean(state.busy || state.workspaceMutation);
  $('preview-git').hidden = !canStage;
  const stage = setText('stage-file', gitScope === 'staged' ? 'Убрать файл из индекса' : 'Добавить файл в индекс');
  stage.disabled = busy;
  $('stage-hunks').disabled = busy;
  $('stage-hunks').hidden = !preview.text?.includes('\n@@ ') || change?.[gitScope] !== 'M';
  const body = $('preview-content');
  body.setAttribute('aria-label', preview.mode === 'files' ? 'Содержимое файла' : 'Изменения файла');
  body.replaceChildren();
  if (preview.loading || preview.error || !preview.text) {
    body.textContent = preview.loading ? 'Загрузка…' : preview.error ?? preview.note
      ?? (preview.mode === 'files' ? 'Пустой файл.' : 'Изменений для этого файла нет.');
    return;
  }

  const lines = preview.text.replace(/\r?\n$/, '').split(/\r?\n/);
  const target = preview.mode === 'files' && Number.isSafeInteger(preview.line) ? preview.line : null;
  const first = target > 3000 ? Math.min(Math.max(0, target - 100), Math.max(0, lines.length - 3000)) : 0;
  let number = preview.mode === 'files' ? first + 1 : null;
  let highlighted;
  let hunkIndex = -1;
  const hunks = [];
  for (const line of lines.slice(first, first + 3000)) {
    let tone = '';
    let label = '';
    if (preview.mode !== 'files') {
      const hunk = /^@@ .+ \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        hunkIndex++;
        number = Number(hunk[1]);
        tone = 'diff-info';
      } else if (number === null) {
        tone = 'diff-info';
      } else if (line.startsWith('-')) {
        tone = 'diff-remove';
      } else if (line.startsWith('+') || line.startsWith(' ')) {
        tone = line.startsWith('+') ? 'diff-add' : '';
        label = String(number++);
      }
    } else {
      label = String(number++);
    }
    const row = element('span', 'code-line ' + tone);
    const gutter = element('span', 'line-number', label);
    gutter.setAttribute('aria-hidden', 'true');
    row.append(gutter, element('span', '', line), document.createTextNode('\n'));
    if (preview.mode === 'review') row.dataset.patchIndex = String(body.childElementCount);
    body.append(row);
    if (tone === 'diff-info' && line.startsWith('@@')) {
      row.classList.add('diff-hunk');
      row.dataset.line = Math.max(1, number);
      hunks.push(row);
      if (hunkIndex === (preview.hunkIndex ?? 0)) { highlighted = row; row.classList.add('line-target'); }
    }
    if (target && Number(label) === target) {
      highlighted = row;
      row.classList.add('line-target');
    }
  }
  if (first || lines.length > 3000) body.append(element('span', 'code-line diff-info',
    'Строки ' + (first + 1) + '–' + Math.min(first + 3000, lines.length) + ' из ' + lines.length));
  if (highlighted) body.scrollTop = Math.max(0, highlighted.offsetTop - body.firstChild.offsetTop - body.clientHeight / 3);
  else if (target > lines.length) body.append(element('span', 'code-line diff-info', 'Строки ' + target + ' в файле нет.'));
  if (preview.mode !== 'files') {
    preview.hunkIndex = Math.max(0, Math.min(preview.hunkIndex ?? 0, hunks.length - 1));
    const count = hunks.length;
    setText('change-position', count ? `${preview.hunkIndex + 1} / ${count}` : 'Нет фрагментов');
    $('previous-change').disabled = !count;
    $('next-change').disabled = !count;
    $('edit-change').disabled = !count;
  }
}

async function openPreview(path, mode, { line = null, scope = 'all', messageId = review?.messageId, hunkIndex = 0 } = {}) {
  if (!state.activeChat) return;
  const chatId = state.activeChat;
  hideEditor();
  const id = ++previewRequest;
  if (!layout.inspectorVisible) showInspector(true);
  selectTab(mode);
  preview = { path, mode, line, scope, messageId, hunkIndex, loading: true };
  renderPreview();
  renderWorkspace();
  const body = $('preview-content');
  body.scrollTop = 0;
  body.scrollLeft = 0;
  try {
    if (mode === 'review') {
      const file = await api.readReviewFile(chatId, messageId, path);
      if (id !== previewRequest) return;
      const note = file.limited ? 'Фрагмент превышает лимит сохранённого сравнения.'
        : file.binary ? 'Содержимое двоичного файла изменилось.'
          : file.status === 'A' ? 'Добавлен пустой файл.' : 'Удалён пустой файл.';
      preview = { path, mode, line, scope, messageId, hunkIndex, text: file.patch, note };
    } else {
      let text;
      if (mode === 'changes') text = await api.readDiff(chatId, path, scope);
      else {
        try { text = await api.readFile(chatId, path); }
        catch (error) {
          if (path.includes('/')) throw error;
          const matches = (await api.searchFiles(chatId, path)).filter(item => item.split('/').at(-1).toLowerCase() === path.toLowerCase());
          if (matches.length !== 1 || matches[0] === path) throw error;
          path = matches[0];
          text = await api.readFile(chatId, path);
        }
      }
      if (id !== previewRequest) return;
      preview = { path, mode, line, scope, hunkIndex, text };
    }
  } catch (error) {
    if (id !== previewRequest) return;
    preview = { path, mode, line, scope, messageId, error: errorText(error) };
  }
  renderPreview();
  renderWorkspace();
  scheduleWorkspaceSave();
}

async function navigateChange(direction) {
  if (!preview || preview.loading) return;
  const count = $('preview-content').querySelectorAll('.diff-hunk').length;
  const next = (preview.hunkIndex ?? 0) + direction;
  if (next >= 0 && next < count) { preview.hunkIndex = next; renderPreview(); scheduleWorkspaceSave(); return; }
  const paths = preview.mode === 'review' ? review?.files.map(file => file.path) : workspace?.changes.map(file => file.path);
  if (!paths?.length) return;
  const path = paths[(paths.indexOf(preview.path) + direction + paths.length) % paths.length];
  await openPreview(path, preview.mode, { ...preview, hunkIndex: direction < 0 ? 2999 : 0 });
  renderPreview();
}
$('previous-change').addEventListener('click', () => navigateChange(-1));
$('next-change').addEventListener('click', () => navigateChange(1));
$('edit-change').addEventListener('click', () => {
  const rows = $('preview-content').querySelectorAll('.diff-hunk');
  const line = Number(rows[preview?.hunkIndex ?? 0]?.dataset.line ?? 1);
  if (preview) void openEditor(preview.path, line);
});

function openReview(message, path) {
  if (!message.review?.files.length || message.chatId !== state.activeChat) return;
  review = { ...message.review, messageId: message.id };
  openPreview(path ?? review.files[0].path, 'review');
}

function closePreview() {
  previewRequest++;
  preview = undefined;
  renderPreview();
  renderWorkspace();
  scheduleWorkspaceSave();
}

function workspaceFile(item, mode, scope = 'all') {
  const button = element('button', 'file');
  button.type = 'button';
  button.title = item.path;
  button.setAttribute('aria-current', String(preview?.path === item.path && preview.mode === mode && preview.scope === scope));
  if (item.status) {
    const [icon, name, tone] = ({
      A: ['+', 'Добавлен', 'added'], '?': ['+', 'Новый', 'added'], D: ['−', 'Удалён', 'deleted'],
      U: ['!', 'Конфликт', 'deleted'],
    })[item.status] ?? ['~', 'Изменён', 'modified'];
    const badge = element('span', 'file-status status-' + tone, icon);
    badge.title = name;
    badge.setAttribute('aria-label', name);
    button.append(badge);
  }
  button.append(element('span', 'file-path', item.name ?? item.path));
  button.addEventListener('click', () => openPreview(item.path, mode, { scope }));
  return button;
}

function renderDirectory(path) {
  const group = element('div', path ? 'file-children' : '');
  const folder = folders.get(path);
  if (!folder?.entries) {
    group.append(element('p', '', folder?.error ?? 'Читаем папку…'));
    return group;
  }
  if (!folder.entries.length) group.append(element('p', '', 'Видимых файлов нет.'));
  const amount = folderLimits.get(path) ?? 180;
  for (const item of folder.entries.slice(0, amount)) {
    if (!item.directory) {
      group.append(workspaceFile(item, 'files'));
      continue;
    }
    const expanded = expandedFolders.has(item.path);
    const button = element('button', 'file folder-item');
    button.type = 'button';
    button.dataset.folder = item.path;
    button.title = item.path;
    button.setAttribute('aria-expanded', String(expanded));
    const chevron = element('span', 'folder-chevron', expanded ? '▾' : '▸');
    chevron.setAttribute('aria-hidden', 'true');
    button.append(chevron, element('span', 'file-path', item.name));
    button.addEventListener('click', () => {
      if (expandedFolders.delete(item.path)) renderWorkspace();
      else {
        expandedFolders.add(item.path);
        if (!folders.get(item.path)?.entries) void loadFolder(item.path);
        renderWorkspace();
      }
      [...$('workspace').querySelectorAll('.folder-item')].find(node => node.dataset.folder === item.path)?.focus();
    });
    group.append(button);
    if (expanded) group.append(renderDirectory(item.path));
  }
  if (folder.entries.length > amount) {
    const more = element('button', 'quiet', 'Показать ещё');
    more.type = 'button';
    more.addEventListener('click', () => {
      folderLimits.set(path, amount + 180);
      renderWorkspace();
    });
    group.append(more);
  }
  return group;
}

function renderWorkspace() {
  const root = $('workspace');
  const focusedFolder = document.activeElement?.dataset.folder;
  root.replaceChildren();
  const count = workspace?.changes.length ?? 0;
  $('git-actions').hidden = tab !== 'changes' || !state.activeChat;
  $('open-commit').disabled = Boolean(state.busy || state.workspaceMutation);
  setText('changes-count', String(count)).hidden = !count;
  if (!state.activeChat) {
    root.append(element('p', '', 'Выберите проект.'));
    return;
  }
  if (tab === 'files') {
    root.append(renderDirectory(''));
    if (focusedFolder) [...root.querySelectorAll('.folder-item')].find(node => node.dataset.folder === focusedFolder)?.focus();
    return;
  }
  if (tab === 'review' && review) {
    root.append(element('div', 'change-heading', 'Изменения за запуск'));
    for (const item of review.files) root.append(workspaceFile(item, 'review'));
    return;
  }
  if (!workspace || workspace.error || !count) {
    root.append(element('p', '', workspace?.error ?? (workspace ? 'Изменений в Git нет.' : 'Читаем состояние Git…')));
    return;
  }
  const sections = [
    ['В индексе', 'staged', item => item.staged],
    ['В рабочей папке', 'unstaged', item => item.unstaged],
    ['Новые файлы', 'all', item => item.untracked ? '?' : null],
  ];
  for (const [title, scope, pickStatus] of sections) {
    const items = workspace.changes.filter(pickStatus);
    if (!items.length) continue;
    root.append(element('div', 'change-heading', title));
    for (const item of items) root.append(workspaceFile({ ...item, status: pickStatus(item) }, 'changes', scope));
  }
}

async function loadFolder(path) {
  const generation = workspaceRequest;
  const pending = {};
  folders.set(path, pending);
  try { pending.entries = await api.listDirectory(state.activeChat, path); }
  catch (error) { pending.error = errorText(error); }
  if (generation === workspaceRequest && folders.get(path) === pending) renderWorkspace();
}

async function refreshWorkspace() {
  const request = ++workspaceRequest;
  renderWorkspace();
  if (!state.activeChat) return;
  const opened = [...expandedFolders].filter(path => path.split('/').slice(0, -1)
    .every((_, index, parts) => expandedFolders.has(parts.slice(0, index + 1).join('/'))));
  const read = api.inspectProject(state.activeChat).catch(error => ({ changes: [], error: errorText(error) }));
  const [result] = await Promise.all([read, loadFolder(''), ...opened.map(path => loadFolder(path))]);
  if (request !== workspaceRequest) return;
  workspace = result;
  renderWorkspace();
  renderThread(false);
  if (preview && preview.mode !== 'review') openPreview(preview.path, preview.mode, preview);
}

function contextLabel(item) {
  const lines = item.start === item.end ? item.start : item.start + '–' + item.end;
  return item.path + ':' + lines;
}

function currentContext() {
  return draftContexts.get(state.activeChat) ?? [];
}

function renderAttachments() {
  const root = $('attachments');
  root.replaceChildren();
  const items = currentContext();
  const external = externalDrafts.get(state.activeChat) ?? [];
  root.hidden = items.length === 0 && external.length === 0;
  items.forEach((item, index) => {
    const chip = element('div', 'attachment');
    const open = element('button', 'quiet', '@ ' + contextLabel(item));
    open.type = 'button';
    open.title = contextLabel(item);
    open.addEventListener('click', () => openFilePicker('attach', '', null, item, index));
    const remove = element('button', 'quiet remove-attachment', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Убрать ' + contextLabel(item));
    remove.addEventListener('click', () => {
      draftContexts.set(state.activeChat, currentContext().filter((_, slot) => slot !== index));
      renderComposer();
      $('prompt').focus();
    });
    chip.append(open, remove);
    root.append(chip);
  });
  for (const item of external) {
    const chip = element('div', 'attachment');
    const label = element('span', 'attachment-name', item.label);
    label.title = item.label;
    const remove = element('button', 'quiet remove-attachment', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Убрать ' + item.label);
    remove.addEventListener('click', async () => {
      const chatId = state.activeChat;
      try {
        await api.removeAttachment(chatId, item.id);
        externalDrafts.set(chatId, (externalDrafts.get(chatId) ?? []).filter(file => file.id !== item.id));
        renderComposer();
      } catch (error) { toast(error); }
    });
    chip.append(label, remove);
    root.append(chip);
  }
}

function renderFileResults() {
  const results = $('file-results');
  results.replaceChildren();
  filePicker.files.forEach((path, index) => {
    const button = element('button', 'history-result');
    button.type = 'button';
    button.id = 'file-result-' + index;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === filePicker.index));
    button.append(element('strong', '', path.split('/').at(-1)), element('small', '', path));
    button.addEventListener('click', () => chooseFile(path));
    results.append(button);
  });
  selectFileResult(filePicker.index);
}

function selectFileResult(index) {
  const count = filePicker.files.length;
  const query = $('file-query');
  filePicker.index = count ? (index + count) % count : -1;
  const rows = $('file-results').children;
  for (const [position, item] of [...rows].entries()) item.setAttribute('aria-selected', String(position === filePicker.index));
  const selected = rows[filePicker.index];
  if (selected) {
    query.setAttribute('aria-activedescendant', selected.id);
    selected.scrollIntoView({ block: 'nearest' });
  } else query.removeAttribute('aria-activedescendant');
}

function updateFileQuery(delay = 120) {
  const picker = filePicker;
  clearTimeout(fileTimer);
  const query = $('file-query').value;
  const suffix = /:(\d+)(?:-\d+)?$/.exec(query);
  const needle = suffix ? query.slice(0, suffix.index) : query;
  picker.line = suffix ? Number(suffix[1]) : null;
  const version = ++picker.searchVersion;
  picker.files = [];
  picker.index = -1;
  renderFileResults();
  setText('file-search-status', 'Ищем файлы…');
  fileTimer = setTimeout(async () => {
    try {
      const files = await api.searchFiles(picker.chatId, needle);
      if (filePicker !== picker || picker.searchVersion !== version) return;
      picker.files = files;
      picker.index = files.length ? 0 : -1;
      renderFileResults();
      setText('file-search-status', files.length === 40 ? 'Первые 40 совпадений. Уточните имя или путь.'
        : files.length ? '' : 'Файлы не найдены.');
    } catch (error) {
      if (filePicker === picker && picker.searchVersion === version) setText('file-search-status', errorText(error));
    }
  }, delay);
}

function openFilePicker(mode, query = '', mention = null, initial = null, replaceSlot = null) {
  const chatId = state.activeChat;
  const dialog = $('file-dialog');
  if (!chatId || document.querySelector('dialog[open]')) return;
  filePicker = { mode, chatId, mention, replaceSlot, files: [], index: -1, searchVersion: 0, contextVersion: 0 };
  $('file-query').value = query;
  $('context-form').hidden = Boolean(!initial);
  $('file-search-pane').hidden = Boolean(initial);
  $('file-results').replaceChildren();
  setText('file-dialog-title', mode === 'attach' ? 'Добавить контекст' : 'Найти файл');
  dialog.showModal();
  if (initial) chooseContextFile(initial.path, initial.start, initial.end);
  else {
    $('file-query').focus();
    updateFileQuery(0);
  }
}

function chooseFile(path) {
  const picker = filePicker;
  if (!picker || picker.chatId !== state.activeChat) return;
  if (picker.mode === 'open') {
    $('file-dialog').close();
    openPreview(path, 'files', { line: picker.line });
  } else chooseContextFile(path, picker.line, picker.line);
}

function chooseContextFile(path, start = null, end = null) {
  filePicker.path = path;
  $('file-search-pane').hidden = true;
  $('context-form').hidden = false;
  setText('context-path', path).title = path;
  $('context-start').value = start ?? '';
  $('context-end').value = end ?? '';
  $('context-start').focus();
  updateContextPreview(0);
}

function updateContextPreview(delay = 160) {
  const picker = filePicker;
  clearTimeout(contextTimer);
  const version = ++picker.contextVersion;
  picker.item = null;
  $('confirm-context').disabled = true;
  $('context-text').hidden = true;
  $('context-end').placeholder = $('context-start').value ? 'Та же строка' : 'До конца';
  setText('context-status', 'Читаем фрагмент…');
  contextTimer = setTimeout(async () => {
    try {
      const range = ['context-start', 'context-end'].map(id => $(id).value === '' ? null : $(id).valueAsNumber);
      const item = await api.previewContext(picker.chatId, picker.path, ...range);
      if (filePicker !== picker || picker.contextVersion !== version) return;
      picker.item = item;
      setText('context-status', 'Фрагмент, который получит модель');
      setText('context-text', item.content).hidden = false;
      $('confirm-context').disabled = false;
    } catch (error) {
      if (filePicker === picker && picker.contextVersion === version) setText('context-status', errorText(error));
    }
  }, delay);
}

async function confirmReplay(message, tool) {
  const chatId = state.activeChat;
  try {
    const details = await api.replayDetails(chatId, message.id, tool.id);
    if (state.activeChat !== chatId || state.busy || document.querySelector('dialog[open]')) return;
    replayTarget = { chatId, messageId: message.id, toolId: tool.id, cwd: details.cwd };
    setText('replay-command', details.command);
    setText('replay-directory', details.cwd);
    $('replay-dialog').showModal();
  } catch (error) { toast(error); }
}

$('file-query').addEventListener('input', () => updateFileQuery());
$('file-query').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    selectFileResult(filePicker.index + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' && filePicker.index >= 0) {
    event.preventDefault();
    chooseFile(filePicker.files[filePicker.index]);
  }
});
$('file-dialog').addEventListener('close', () => {
  if ($('file-dialog').open) return;
  clearTimeout(fileTimer);
  clearTimeout(contextTimer);
  filePicker = undefined;
});
$('context-back').addEventListener('click', () => {
  filePicker.contextVersion++;
  $('context-form').hidden = true;
  $('file-search-pane').hidden = false;
  $('file-query').focus();
  updateFileQuery(0);
});
for (const id of ['context-start', 'context-end']) $(id).addEventListener('input', () => updateContextPreview());
$('context-form').addEventListener('submit', event => {
  event.preventDefault();
  const picker = filePicker;
  if (!picker?.item || picker.chatId !== state.activeChat) return;
  const { content, ...reference } = picker.item;
  const items = [...currentContext()];
  if (picker.replaceSlot != null) items[picker.replaceSlot] = reference;
  else if (items.length < 6 && !items.some(item => item.digest === reference.digest)) items.push(reference);
  draftContexts.set(picker.chatId, items);
  const prompt = $('prompt');
  const { mention } = picker;
  if (mention && prompt.value.slice(mention.start, mention.end) === mention.text) {
    prompt.setRangeText('', mention.start, mention.end, 'end');
  }
  $('file-dialog').close();
  renderComposer();
  prompt.focus();
});
$('find-file').addEventListener('click', () => openFilePicker('open'));
$('attach-file').addEventListener('click', () => openFilePicker('attach'));
$('attach-preview').addEventListener('click', () => {
  if (preview && currentContext().length < 6) openFilePicker('attach', '', null, { path: preview.path, start: preview.line, end: preview.line });
});
$('replay-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = replayTarget;
  $('replay-dialog').close();
  if (!target || target.chatId !== state.activeChat || state.busy) return;
  try { await api.replayTest(target.chatId, target.messageId, target.toolId, target.cwd); }
  catch (error) { toast(error); }
});

api.onState(updateState);
api.onUpdate(update => {
  if (!state) return;
  state.updates = update;
  renderUpdates();
});
api.onCatalog(catalog => {
  if (!state) return;
  Object.assign(state, catalog);
  renderModels();
  renderComposer();
});
api.onMessage(message => {
  if (message.chatId !== state?.activeChat) return;
  const index = state.messages.findIndex(item => item.id === message.id);
  if (index === -1) return;
  const scroll = atBottom();
  state.messages[index] = message;
  document.querySelector(`[data-message-id="${message.id}"]`)?.replaceWith(renderMessage(message));
  if (typeof renderWorkflow === 'function') renderWorkflow();
  if (scroll) scrollBottom();
});

$('create-project').addEventListener('click', () => {
  createParent = state.projectRoot;
  setText('project-path', createParent);
  $('project-form').reset();
  $('project-error').hidden = true;
  $('project-dialog').showModal();
  $('project-name').focus();
});
$('choose-path').addEventListener('click', async () => {
  try {
    const path = await api.chooseFolder();
    if (path) setText('project-path', createParent = path);
  } catch (error) { toast(error); }
});
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('confirm-project').disabled = true;
  try {
    updateState(await api.createProject($('project-name').value, createParent));
    $('project-dialog').close();
    $('prompt').focus();
  } catch (error) {
    setText('project-error', errorText(error)).hidden = false;
  } finally {
    $('confirm-project').disabled = false;
  }
});
$('open-project').addEventListener('click', async () => {
  try { updateState(await api.openProject()); } catch (error) { toast(error); }
});
$('search-history').addEventListener('click', openSearch);
$('history-query').addEventListener('input', searchHistory);
$('history-query').addEventListener('keydown', event => {
  if (!searchResults.length) return;
  if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    selectedResult = (selectedResult + delta + searchResults.length) % searchResults.length;
    renderSearchSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    openSearchResult(searchResults[selectedResult]);
  }
});
$('history-dialog').addEventListener('close', () => {
  clearTimeout(searchTimer);
  searchRequest++;
});

$('rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!renameTarget) return;
  const save = event.submitter ?? $('rename-form').querySelector('[type="submit"]');
  save.disabled = true;
  try {
    const rename = renameTarget.kind === 'project' ? api.renameProject : api.renameChat;
    updateState(await rename(renameTarget.id, $('rename-input').value));
    $('rename-dialog').close();
  } catch (error) {
    setText('rename-error', errorText(error)).hidden = false;
  } finally {
    save.disabled = false;
  }
});

async function newChat() {
  const chat = activeChat();
  if (!chat) return;
  try {
    updateState(await api.newChat(chat.projectId));
    $('prompt').focus();
  } catch (error) { toast(error); }
}
$('new-chat').addEventListener('click', newChat);
$('new-chat').setAttribute('aria-keyshortcuts', 'Control+n');
$('new-chat').title = 'Новый чат · Ctrl+N';
$('model').addEventListener('change', async () => {
  try {
    updateState(await api.selectModel(activeChat().id, $('model').value));
  } catch (error) {
    renderModels();
    toast(error);
  }
});
$('settings').addEventListener('click', () => {
  $('settings-form').reset();
  $('settings-error').hidden = true;
  $('provider-mode').value = state.providerMode;
  readSettingsFields();
  $('settings-dialog').showModal();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('save-settings').disabled = true;
  try {
    updateState(await api.saveKey({ mode: $('provider-mode').value, folderId: $('folder-id').value.trim(),
      apiKey: $('api-key').value, tokenSource: $('token-source').value,
      cliProfile: $('cli-profile').value, iamToken: $('iam-token').value }));
    $('settings-form').reset();
    $('settings-dialog').close();
  } catch (error) {
    setText('settings-error', errorText(error)).hidden = false;
  } finally {
    $('save-settings').disabled = false;
  }
});
$('check-updates').addEventListener('click', () => api.checkUpdates().catch(toast));
$('install-update').addEventListener('click', () => api.installUpdate().catch(toast));
$('refresh-models').addEventListener('click', () => api.refreshModels().catch(toast));
for (const button of document.querySelectorAll('.close-dialog')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('prompt').addEventListener('input', event => {
  renderComposer();
  if (event.isComposing || $('attach-file').disabled) return;
  const prompt = $('prompt');
  if (prompt.selectionStart !== prompt.selectionEnd || !event.data?.includes('@')) return;
  const end = prompt.selectionStart;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prompt.value.slice(0, end));
  if (!match) return;
  const text = '@' + match[1];
  openFilePicker('attach', match[1], { start: end - text.length, end, text });
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('prompt').value;
  if ($('send').disabled || !state.activeChat || !input.trim()) return;
  const chatId = state.activeChat;
  const attachments = currentContext();
  const files = externalDrafts.get(chatId) ?? [];
  $('prompt').value = '';
  draftContexts.delete(chatId);
  externalDrafts.delete(chatId);
  sending = true;
  renderComposer();
  try { await api.send(chatId, input, attachments, files.map(item => item.id)); }
  catch (error) {
    if (state.activeChat === chatId && !$('prompt').value) $('prompt').value = input;
    if (state.activeChat !== chatId && !drafts.get(chatId)) drafts.set(chatId, input);
    if (attachments.length && !draftContexts.get(chatId)?.length) draftContexts.set(chatId, attachments);
    if (files.length) externalDrafts.set(chatId, [...files, ...(externalDrafts.get(chatId) ?? [])]);
    toast(error);
  } finally {
    sending = false;
    renderComposer();
  }
});
$('stop').addEventListener('click', () => api.stop().catch(toast));
async function decidePermission(allow) {
  const id = permissionId;
  if (!id) return;
  $('allow').disabled = $('deny').disabled = true;
  try { await api.permission(id, allow); }
  catch (error) {
    if (permissionId === id) $('allow').disabled = $('deny').disabled = false;
    toast(error);
  }
}
$('allow').addEventListener('click', () => decidePermission(true));
$('deny').addEventListener('click', () => decidePermission(false));
$('reveal').addEventListener('click', async () => {
  try {
    const error = await api.revealProject(state.activeChat);
    if (error) toast(error);
  } catch (error) { toast(error); }
});
$('toggle-inspector').addEventListener('click', () => {
  showInspector($('inspector').hidden);
});
bindGrip('sidebar', 1);
bindGrip('inspector', -1);
window.addEventListener('resize', renderLayout);
document.addEventListener('keydown', event => {
  if (!state || event.altKey || event.isComposing || event.repeat) return;
  const modal = document.querySelector('dialog[open]');
  if (modal && modal.id !== 'history-dialog') return;
  if (event.ctrlKey && !event.shiftKey && event.code === 'KeyK') {
    event.preventDefault();
    openSearch();
  } else if (!modal && event.ctrlKey && !event.shiftKey && event.code === 'KeyP' && activeChat()) {
    event.preventDefault();
    openFilePicker('open');
  } else if (!modal && event.ctrlKey && !event.shiftKey && event.code === 'KeyN' && activeChat()) {
    event.preventDefault();
    newChat();
  } else if (!modal && event.key === 'F2' && !event.ctrlKey && activeChat()) {
    event.preventDefault();
    const chat = activeChat();
    if (event.shiftKey) openRename('project', state.projects.find(project => project.id === chat.projectId));
    else openRename('chat', chat);
  } else if (!modal && event.ctrlKey && event.shiftKey && event.code === 'KeyE') {
    event.preventDefault();
    showInspector($('inspector').hidden);
  } else if (!modal && event.ctrlKey && event.shiftKey && event.code === 'KeyF') {
    event.preventDefault();
    openContentSearch();
  }
});
$('close-preview').addEventListener('click', closePreview);
for (const name of ['files', 'changes', 'review']) {
  $(`${name}-tab`).addEventListener('click', () => {
    if (name !== 'files') hideEditor();
    if (tab !== name) closePreview();
    selectTab(name);
    if (name === 'review') {
      if (!preview && review) openPreview(review.files[0].path, 'review');
    } else refreshWorkspace();
  });
}
function openChatActions(chat) {
  chatAction = chat;
  setText('chat-actions-title', chat.title);
  setText('toggle-archive-chat', chat.archivedAt ? 'Восстановить из архива' : 'В архив').disabled = state.busy === chat.id;
  $('request-delete-chat').disabled = state.busy === chat.id || state.workspaceMutation;
  $('chat-actions-dialog').showModal();
}

async function toggleArchive(chat) {
  if (!chat) return;
  try {
    if (!chat.archivedAt) openArchives.add(chat.projectId);
    updateState(await api.archiveChat(chat.id, !chat.archivedAt));
  } catch (error) { toast(error); }
}

function editorGroup() {
  const projectId = activeChat()?.workspace ? 'task:' + activeChat().id : activeChat()?.projectId;
  if (!editorFiles.has(projectId) && projectId) editorFiles.set(projectId, new Map());
  return editorFiles.get(projectId);
}

function renderEditorTabs() {
  const tabs = $('editor-tabs');
  const files = editorGroup();
  tabs.hidden = tab !== 'files' || !files?.size;
  tabs.replaceChildren();
  if (tabs.hidden) return;
  for (const file of files.values()) {
    const group = element('span', 'editor-tab');
    const open = element('button', 'quiet', file.path.split('/').at(-1) + (file.dirty ? ' ●' : ''));
    open.title = file.path + (file.dirty ? ' — есть несохранённые изменения' : '');
    open.setAttribute('aria-current', String(editView === file));
    open.addEventListener('click', () => openEditor(file.path));
    const close = element('button', 'quiet editor-close', '×');
    close.setAttribute('aria-label', 'Закрыть ' + file.path);
    close.addEventListener('click', () => closeEditorTab(files, file));
    group.append(open, close);
    tabs.append(group);
  }
  $('save-file').disabled = !editView?.dirty || Boolean(state.busy || state.workspaceMutation);
}

function hideEditor() {
  editorRequest++;
  if (!editView) return;
  if (editor) Object.assign(editView, editor.position());
  editor?.destroy();
  editor = undefined;
  editView = undefined;
  $('inline-editor').hidden = true;
  $('inspector').classList.toggle('reviewing', Boolean(preview));
  renderLayout();
}

function showEditor(file, line, focus = true) {
  hideEditor();
  preview = undefined;
  previewRequest++;
  editView = file;
  editor = window.aliceEditor.create($('editor-host'), file, text => {
    const changed = file.dirty !== (text !== file.cleanText);
    file.text = text;
    file.dirty = text !== file.cleanText;
    if (typeof changedCode === 'function') changedCode();
    if (changed) renderEditorTabs();
    scheduleWorkspaceSave();
  }, saveCurrentFile, scheduleWorkspaceSave);
  $('inline-editor').hidden = false;
  setText('editor-title', file.path).title = file.path;
  selectTab('files');
  renderPreview();
  renderWorkspace();
  if (line) editor.line(line);
  if (focus) editor.focus();
  scheduleWorkspaceSave();
}

async function openEditor(path, line, focus = true) {
  if (editView?.path === path) {
    if (line) editor.line(line);
    if (focus) editor.focus();
    return;
  }
  if (!window.aliceEditor) return toast('Редактор не загрузился. Перезапустите Alicecode.');
  const files = editorGroup();
  if (!files) return;
  const request = ++editorRequest;
  try {
    let file = files.get(path);
    if (!file?.dirty) {
      const next = await api.readEditor(state.activeChat, path);
      if (request !== editorRequest || files !== editorGroup()) return;
      file = { ...next, cleanText: next.text, dirty: false, selection: file?.selection, scrollTop: file?.scrollTop };
      files.set(file.path, file);
    }
    showEditor(file, line, focus);
  } catch (error) { toast(error); }
}

function closeEditorTab(files, file) {
  if (file.dirty && !window.confirm('Закрыть «' + file.path + '» без сохранения?')) return;
  files.delete(file.path);
  if (editView === file) {
    hideEditor();
    const next = [...files.values()].at(-1);
    if (next) showEditor(next);
    else void openPreview(file.path, 'files');
  }
  renderEditorTabs();
  scheduleWorkspaceSave();
}

async function saveCurrentFile() {
  const file = editView;
  const chatId = state.activeChat;
  if (!file?.dirty || state.busy || state.workspaceMutation) return;
  const draft = file.text;
  try {
    const result = await api.saveFile(chatId, file.path, file.stamp, draft);
    if (result.conflict) {
      if (editView === file && !document.querySelector('dialog[open]')) {
        editorConflict = { file, result };
        setText('editor-conflict-diff', result.patch || 'Содержимое совпадает.');
        $('editor-conflict-dialog').showModal();
      }
      return;
    }
    file.stamp = result.stamp;
    file.cleanText = result.text;
    file.dirty = file.text !== result.text;
    if (editView === file) renderEditorTabs();
  } catch (error) { toast(error); }
}

function openRollback(message) {
  const dialog = $('rollback-dialog');
  rollbackTarget = { chatId: message.chatId, id: message.id, request: 0 };
  $('rollback-file').replaceChildren(...message.managedPaths.map(path => {
    const option = element('option', '', path);
    option.value = path;
    return option;
  }));
  dialog.showModal();
  updateRollbackPreview();
}

async function updateRollbackPreview() {
  const target = rollbackTarget;
  const request = ++target.request;
  const path = $('rollback-file').value;
  $('apply-rollback').disabled = true;
  setText('rollback-status', 'Сравниваем версии…');
  setText('rollback-diff', '');
  try {
    if (editorGroup()?.get(path)?.dirty) throw new Error('Сохраните или закройте черновик этого файла.');
    const result = await api.rollbackPreview(target.chatId, target.id, path);
    if (target !== rollbackTarget || request !== target.request || !$('rollback-dialog').open) return;
    target.preview = result;
    target.path = path;
    const detail = result.conflict ? 'Конфликт. Проверьте версии фрагмента.'
      : result.patch ? 'Предпросмотр изменения рабочего файла.' : 'Правка уже отсутствует в рабочем файле.';
    setText('rollback-status', detail + (result.staged ? ' Для этого файла также есть изменения в индексе Git.' : ''));
    setText('rollback-diff', result.conflict ?? result.patch ?? '');
    $('apply-rollback').disabled = Boolean(result.conflict);
  } catch (error) {
    if (target === rollbackTarget && request === target.request) setText('rollback-status', errorText(error));
  }
}

async function loadCommit() {
  const target = commitTarget;
  $('confirm-commit').disabled = true;
  try {
    const info = await api.commitPreview(target.chatId);
    if (target !== commitTarget || !$('commit-dialog').open) return;
    target.token = info.token;
    setText('commit-branch', info.branch + ' · ' + info.repo);
    setText('commit-paths', info.paths.length ? info.paths.join('\n') : 'В индексе нет изменений.');
    setText('commit-diff', info.diff).hidden = !info.diff;
    $('confirm-commit').disabled = !info.paths.length;
  } catch (error) { setText('commit-error', errorText(error)).hidden = false; }
}

$('toggle-archive-chat').addEventListener('click', () => {
  $('chat-actions-dialog').close();
  void toggleArchive(chatAction);
});
$('restore-active-chat').addEventListener('click', () => toggleArchive(activeChat()));
$('menu-rename-chat').addEventListener('click', () => {
  $('chat-actions-dialog').close();
  openRename('chat', chatAction);
});
$('request-delete-chat').addEventListener('click', () => {
  $('chat-actions-dialog').close();
  setText('delete-chat-name', chatAction.title);
  $('delete-chat-dialog').showModal();
});
$('delete-chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = chatAction;
  try {
    updateState(await api.deleteChat(target.id));
    drafts.delete(target.id);
    draftContexts.delete(target.id);
    externalDrafts.delete(target.id);
    $('delete-chat-dialog').close();
  } catch (error) { toast(error); }
});
$('search-archive').addEventListener('change', searchHistory);
$('edit-preview').addEventListener('click', () => { if (preview) openEditor(preview.path, preview.line); });
$('save-file').addEventListener('click', saveCurrentFile);
$('editor-find').addEventListener('click', () => editor?.search());
$('editor-line').addEventListener('click', () => editor?.go());
$('reload-editor').addEventListener('click', () => {
  const { file, result } = editorConflict;
  Object.assign(file, { stamp: result.stamp, text: result.text, cleanText: result.text, dirty: false });
  $('editor-conflict-dialog').close();
  if (editView === file) showEditor(file);
});
window.addEventListener('beforeunload', event => {
  const result = api.flushWorkspace(workspaceValues());
  if (result.error) {
    toast(result.error);
    event.preventDefault();
    event.returnValue = false;
  }
});
$('rollback-file').addEventListener('change', updateRollbackPreview);
$('rollback-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = rollbackTarget;
  if ($('apply-rollback').disabled || !target.preview) return;
  $('apply-rollback').disabled = true;
  try {
    await api.rollback(target.chatId, target.id, target.path, target.preview.token);
    $('rollback-dialog').close();
  } catch (error) { setText('rollback-status', errorText(error)); }
});
$('stage-file').addEventListener('click', async () => {
  if (preview?.mode !== 'changes') return;
  try { await api.stageFile(state.activeChat, preview.path, preview.scope !== 'staged'); }
  catch (error) { toast(error); }
});
$('stage-hunks').addEventListener('click', async () => {
  if (preview?.mode !== 'changes') return;
  const { path, scope } = preview;
  const chatId = state.activeChat;
  try {
    const { hunks, token } = await api.gitHunks(chatId, path, scope);
    if (state.activeChat !== chatId || document.querySelector('dialog[open]')) return;
    stageTarget = { chatId, path, scope, token };
    setText('hunks-title', scope === 'staged' ? 'Убрать фрагменты из индекса' : 'Добавить фрагменты в индекс');
    setText('hunks-path', path);
    $('hunks-list').replaceChildren(...hunks.map((patch, index) => {
      const item = element('div', 'hunk-choice');
      const label = element('label', 'check-label');
      const control = element('input');
      control.type = 'checkbox';
      control.value = index;
      label.append(control, document.createTextNode(patch.split('\n')[0]));
      item.append(label, element('pre', 'context-text', patch));
      return item;
    }));
    $('hunks-dialog').showModal();
  } catch (error) { toast(error); }
});
$('hunks-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = stageTarget;
  const selected = [...$('hunks-list').querySelectorAll('input:checked')].map(input => Number(input.value));
  if (!selected.length) return;
  try {
    await api.stageHunks(target.chatId, target.path, target.scope, selected, target.token);
    $('hunks-dialog').close();
  } catch (error) { toast(error); }
});
$('open-commit').addEventListener('click', () => {
  commitTarget = { chatId: state.activeChat, token: null };
  $('commit-form').reset();
  setText('commit-branch', 'Читаем индекс Git…');
  setText('commit-paths', '');
  $('commit-diff').hidden = true;
  $('commit-error').hidden = true;
  $('commit-dialog').showModal();
  void loadCommit();
});
$('commit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = commitTarget;
  if (!target.token || $('confirm-commit').disabled) return;
  $('confirm-commit').disabled = true;
  $('commit-error').hidden = true;
  try {
    const hash = await api.commit(target.chatId, target.token, $('commit-message').value);
    target.token = null;
    setText('commit-paths', 'Создан коммит ' + hash);
    $('commit-diff').hidden = true;
    $('commit-message').value = '';
  } catch (error) {
    setText('commit-error', errorText(error)).hidden = false;
    await loadCommit();
  }
});

function canAttach() {
  const chat = activeChat();
  return Boolean(chat && !chat.archivedAt && !attachmentBusy && (externalDrafts.get(chat.id)?.length ?? 0) < 32);
}

function selectionCount() {
  const count = attachmentSelection.selected.size;
  const current = externalDrafts.get(attachmentSelection.chatId)?.length ?? 0;
  setText('attachments-count', 'Выбрано ' + count);
  $('confirm-attachments').disabled = !count || count + current > 32;
}

function renderAttachmentChoices() {
  const picker = attachmentSelection;
  const query = $('attachments-query').value.trim().toLowerCase();
  const root = $('attachments-files');
  root.replaceChildren();
  const groups = new Map([['', root]]);
  function container(segments) {
    if (!segments.length) return root;
    const prefix = segments.join('/');
    if (!groups.has(prefix)) {
      const details = element('details', 'attachment-directory');
      details.open = Boolean(query) || segments.length === 1;
      details.append(element('summary', '', segments.at(-1)));
      const children = element('div', 'attachment-directory-children');
      details.append(children);
      container(segments.slice(0, -1)).append(details);
      groups.set(prefix, children);
    }
    return groups.get(prefix);
  }
  let found = 0;
  for (const file of picker.items) {
    if (query && !file.label.toLowerCase().includes(query)) continue;
    found++;
    const segments = file.label.split('/');
    const row = element('div', 'attachment-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = picker.selected.has(file.id);
    input.disabled = file.tooLarge;
    input.setAttribute('aria-label', file.label);
    input.addEventListener('change', () => {
      if (input.checked) picker.selected.add(file.id);
      else picker.selected.delete(file.id);
      selectionCount();
    });
    const inspect = element('button', 'quiet', segments.at(-1));
    inspect.type = 'button';
    inspect.title = file.label;
    inspect.disabled = file.tooLarge;
    inspect.addEventListener('click', () => peekAttachment(picker, file));
    const size = element('span', 'muted attachment-size', file.tooLarge ? 'Больше 512 КБ'
      : Math.max(1, Math.ceil(file.size / 1024)) + ' КБ');
    row.append(input, inspect, size);
    container(segments.slice(0, -1)).append(row);
  }
  if (!found) root.append(element('p', 'muted', 'Подходящих файлов нет.'));
  selectionCount();
}

async function peekAttachment(picker, file) {
  const view = ++picker.preview;
  setText('attachment-peek-title', file.label);
  setText('attachment-peek-text', 'Чтение…');
  $('attachment-peek').hidden = false;
  try {
    const result = await api.previewAttachment(picker.chatId, picker.key, file.id);
    if (attachmentSelection === picker && picker.preview === view) {
      setText('attachment-peek-text', result.text + (result.truncated ? '\n\n… Показано начало файла.' : ''));
    }
  } catch (error) {
    if (attachmentSelection === picker && picker.preview === view) setText('attachment-peek-text', errorText(error));
  }
}

async function pickAttachments(get) {
  if (!canAttach() || document.querySelector('dialog[open]')) return;
  const chatId = state.activeChat;
  attachmentBusy = true;
  renderComposer();
  try {
    const choice = await get(chatId);
    if (!choice || state.activeChat !== chatId) return;
    const selected = new Set(choice.items.filter(item => item.individual && !item.tooLarge).map(item => item.id));
    attachmentSelection = { ...choice, chatId, selected, preview: 0 };
    $('attachments-query').value = '';
    $('attachments-query').hidden = choice.items.length < 8;
    $('attachment-peek').hidden = true;
    $('attachments-error').hidden = true;
    setText('attachments-status', choice.truncated ? 'Показаны первые найденные файлы. Для остальных выберите подпапку.'
      : 'Отметьте файлы, которые Алиса сможет прочитать.');
    renderAttachmentChoices();
    $('attachments-dialog').showModal();
  } catch (error) { toast(error); }
  finally {
    attachmentBusy = false;
    renderComposer();
  }
}

async function openSavedAttachment(chatId, id) {
  try {
    const file = await api.readAttachment(chatId, id);
    if (state.activeChat !== chatId || document.querySelector('dialog[open]')) return;
    setText('saved-attachment-title', file.label);
    setText('saved-attachment-text', file.text + (file.truncated ? '\n\n… Показано начало файла.' : ''));
    $('saved-attachment-dialog').showModal();
  } catch (error) { toast(error); }
}

function readSettingsFields(reset = true) {
  const mode = $('provider-mode').value;
  const saved = state.providerSettings[mode];
  const subscription = mode === 'subscription';
  if (reset) {
    $('folder-id').value = saved?.folderId ?? '';
    $('token-source').value = saved?.tokenSource ?? 'cli';
    $('cli-profile').value = saved?.cliProfile ?? '';
    $('api-key').value = '';
    $('iam-token').value = '';
  }
  const manual = $('token-source').value === 'manual';
  $('key-auth-fields').hidden = subscription;
  $('subscription-auth-fields').hidden = !subscription;
  $('iam-auth-fields').hidden = !manual;
  $('cli-auth-fields').hidden = manual;
  $('api-key').placeholder = !subscription && saved ? 'Ключ сохранён' : '';
  $('iam-token').placeholder = subscription && saved?.tokenSource === 'manual' ? 'Токен сохранён' : '';
  $('check-provider').disabled = !state.configured || mode !== state.providerMode;
  $('provider-test-status').hidden = true;
  setText('settings-status', subscription ? 'Лимиты подписки Yandex Cloud. Используйте каталог облака с подпиской.'
    : 'Оплата по потреблению через API-ключ.');
}

$('attach-external').addEventListener('click', () => pickAttachments(id => api.chooseAttachments(id, 'files')));
$('attach-folder').addEventListener('click', () => pickAttachments(id => api.chooseAttachments(id, 'folder')));
$('attachments-query').addEventListener('input', renderAttachmentChoices);
$('attachments-form').addEventListener('submit', async event => {
  event.preventDefault();
  const picker = attachmentSelection;
  if ($('confirm-attachments').disabled || picker.chatId !== state.activeChat) return;
  $('confirm-attachments').disabled = true;
  $('attachments-error').hidden = true;
  try {
    const files = await api.attachFiles(picker.chatId, picker.key, [...picker.selected]);
    externalDrafts.set(picker.chatId, [...(externalDrafts.get(picker.chatId) ?? []), ...files]);
    $('attachments-dialog').close();
    renderComposer();
    $('prompt').focus();
  } catch (error) {
    setText('attachments-error', errorText(error)).hidden = false;
    selectionCount();
  }
});
const chatDrop = document.querySelector('.conversation');
const hasFiles = event => event.dataTransfer?.types.includes('Files');
chatDrop.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (!state || !canAttach()) return;
  event.dataTransfer.dropEffect = 'copy';
  $('drop-context').hidden = false;
});
chatDrop.addEventListener('dragleave', event => {
  if (!chatDrop.contains(event.relatedTarget)) $('drop-context').hidden = true;
});
chatDrop.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  $('drop-context').hidden = true;
  const files = [...event.dataTransfer.files];
  if (files.length) void pickAttachments(id => api.dropAttachments(id, files));
});
$('provider-mode').addEventListener('change', () => readSettingsFields());
$('token-source').addEventListener('change', () => readSettingsFields(false));
$('check-provider').addEventListener('click', async () => {
  const button = $('check-provider');
  button.disabled = true;
  setText('provider-test-status', 'Проверяем активное подключение…').hidden = false;
  try {
    await api.checkProvider();
    setText('provider-test-status', 'Модель ответила. Подключение работает.');
  } catch (error) { setText('provider-test-status', errorText(error)); }
  finally { button.disabled = !state.configured || $('provider-mode').value !== state.providerMode; }
});

function workspaceValues() {
  if (!state?.activeChat || restoringWorkspace) return [];
  const chat = activeChat();
  if (!chat) return [];
  if (editView && editor) Object.assign(editView, editor.position());
  const value = { draft: $('prompt').value, context: currentContext(), view: {
    tab, scrollTop: $('thread').scrollTop, atBottom: atBottom(), reviewMessageId: review?.messageId,
    editorPath: editView?.path,
    workflow: typeof workflowView === 'function' ? workflowView() : undefined,
    preview: preview ? { path: preview.path, mode: preview.mode, line: preview.line, scope: preview.scope,
      messageId: preview.messageId, hunkIndex: preview.hunkIndex } : null,
  } };
  drafts.set(chat.id, value.draft);
  chatViews.set(chat.id, value.view);
  return [['chat', chat.id, value], [chat.workspace ? 'editor' : 'project', chat.workspace ? chat.id : chat.projectId, { files: [...(editorGroup()?.values() ?? [])] }]];
}

function persistWorkspace() {
  clearTimeout(workspaceTimer);
  for (const [scope, id, value] of workspaceValues()) void api.saveWorkspace(scope, id, value).catch(toast);
}

function scheduleWorkspaceSave() {
  if (!state || restoringWorkspace) return;
  clearTimeout(workspaceTimer);
  workspaceTimer = setTimeout(persistWorkspace, 180);
}

async function restoreWorkspace(view) {
  const generation = ++restoreGeneration;
  restoringWorkspace = true;
  try {
    const message = state.messages.find(item => item.id === view.reviewMessageId);
    if (message?.review?.files.length) review = { ...message.review, messageId: message.id };
    selectTab(view.tab === 'review' && review ? 'review' : view.tab === 'changes' ? 'changes' : 'files');
    if (view.preview?.path && (view.preview.mode !== 'review' || review)) await openPreview(view.preview.path, view.preview.mode, view.preview);
    else if (view.editorPath) await openEditor(view.editorPath, null, false);
    renderWorkspace();
    if (generation !== restoreGeneration) return;
    if (view.atBottom !== false) scrollBottom();
    else $('thread').scrollTop = Math.max(0, view.scrollTop ?? 0);
  } finally {
    if (generation === restoreGeneration) restoringWorkspace = false;
  }
}

$('thread').addEventListener('scroll', scheduleWorkspaceSave);
$('chat-mode').addEventListener('change', async () => {
  try { updateState(await api.selectMode(state.activeChat, $('chat-mode').value)); }
  catch (error) { toast(error); renderComposer(); }
});

function openContentSearch() {
  if (!activeChat() || document.querySelector('dialog[open]')) return;
  $('content-dialog').showModal();
  $('content-query').focus();
  $('content-query').select();
}

async function runContentSearch() {
  const request = ++contentRequest;
  const chatId = state.activeChat;
  const query = $('content-query').value.trim();
  $('content-results').replaceChildren();
  if (!query) { setText('content-status', 'Введите текст для поиска.'); return; }
  setText('content-status', 'Ищем…');
  try {
    const result = await api.searchContent(chatId, query);
    if (request !== contentRequest || chatId !== state.activeChat || !$('content-dialog').open) return;
    setText('content-status', `${result.matches.length} совпадений · проверено файлов: ${result.scanned}`
      + (result.skipped ? ` · пропущено: ${result.skipped}` : '')
      + (result.limited ? ' · достигнут лимит, уточните запрос' : ''));
    for (const match of result.matches) {
      const row = element('div', 'content-result');
      const open = element('button', 'content-hit'); open.type = 'button';
      open.append(element('strong', '', match.path + ':' + match.line), element('code', '', match.snippet));
      open.addEventListener('click', () => { $('content-dialog').close(); showInspector(true); void openEditor(match.path, match.line); });
      const attach = element('button', 'quiet content-attach', '@ В чат'); attach.type = 'button';
      attach.disabled = currentContext().length >= 6 || Boolean(activeChat()?.archivedAt);
      attach.addEventListener('click', async () => {
        try {
          const fragment = await api.previewContext(chatId, match.path, Math.max(1, match.line - 2), Math.min(match.totalLines, match.line + 2));
          if (state.activeChat !== chatId || currentContext().length >= 6) return;
          const { content, ...ref } = fragment;
          if (!currentContext().some(item => item.digest === ref.digest)) draftContexts.set(chatId, [...currentContext(), ref]);
          $('content-dialog').close(); renderComposer(); $('prompt').focus();
        } catch (error) { toast(error); }
      });
      row.append(open, attach); $('content-results').append(row);
    }
  } catch (error) { if (request === contentRequest) setText('content-status', errorText(error)); }
}
$('find-content').addEventListener('click', openContentSearch);
$('content-query').addEventListener('input', () => { clearTimeout(contentTimer); contentRequest++; contentTimer = setTimeout(runContentSearch, 280); });
$('content-query').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); clearTimeout(contentTimer); void runContentSearch(); }
});

function renderTask(message, expanded = false) {
  const task = message.task;
  const panel = element('section', 'task-card');
  const head = element('div', 'task-heading');
  head.append(element('strong', '', task.steps.length ? 'План выполнения' : 'Задача'));
  if (task.approval === 'bypass' && message.mode === 'code') head.append(element('span', 'bypass-badge', 'Bypass'));
  if (task.workspace) head.append(element('span', 'task-branch-label', task.workspace.branch));
  panel.append(head);
  if (!expanded) {
    const done = task.steps.filter(step => step.status === 'done').length;
    const labels = { done: 'Готово', running: 'Выполняется', planning: 'Составляем план', stopped: 'Остановлено', error: 'Ошибка' };
    const show = element('button', 'quiet', (labels[task.status] ?? task.status) + (task.steps.length ? ` · шаги ${done}/${task.steps.length}` : '') + ' · Открыть задачу');
    show.type = 'button'; show.addEventListener('click', () => { workflowTaskId = message.id; openWorkflow('task'); }); panel.append(show);
    return panel;
  }
  if (task.steps.length) {
    const steps = element('ol', 'task-steps');
    const labels = { pending: 'Ожидает', running: 'Выполняется', done: 'Готово', error: 'Ошибка', stopped: 'Остановлено' };
    for (const step of task.steps) {
      const row = element('li', 'task-step step-' + step.status);
      row.append(element('span', 'step-state', labels[step.status] ?? step.status), document.createTextNode(step.title));
      if (step.note) row.append(element('small', '', step.note));
      if (step.evidence?.length) {
        const evidence = element('details', 'step-evidence'); evidence.append(element('summary', '', 'Действия · ' + step.evidence.length));
        for (const tool of step.evidence) evidence.append(element('div', '', tool.title + (Number.isInteger(tool.exitCode) ? ' · код ' + tool.exitCode : '')));
        row.append(evidence);
      }
      steps.append(row);
    }
    panel.append(steps);
    if (message.status !== 'running' && task.steps.some(step => step.status !== 'done')) {
      const resume = element('button', 'quiet', 'Продолжить план'); resume.type = 'button';
      resume.disabled = Boolean(state.busy || state.workspaceMutation || activeChat()?.archivedAt);
      resume.addEventListener('click', () => api.resumeTask(message.chatId, message.id).catch(toast)); panel.append(resume);
    }
  } else if (task.status === 'planning') panel.append(element('p', 'busy-text', 'Алиса составляет план…'));
  if (task.profile?.name) panel.append(element('span','task-branch-label',task.profile.name + ' · ' + (task.profile.directory || '.')));
  for (const file of task.instructions.sources ?? [task.instructions]) {
    if (!file.exists && !file.text) continue;
    const button = element('button', 'quiet task-instructions', file.path + ' · снимок инструкций'); button.type = 'button';
    button.addEventListener('click', () => openInstructions(file)); panel.append(button);
  }
  return panel;
}

async function openInstructions(snapshot = null, path = 'AGENTS.md') {
  if (document.querySelector('dialog[open]')) return;
  const chatId = state.activeChat;
  try {
    const file = snapshot ?? await api.instructions(chatId,path);
    instructionsTarget = { chatId, file, snapshot: Boolean(snapshot) };
    $('instructions-text').value = file.text;
    $('instructions-text').readOnly = Boolean(snapshot);
    $('instructions-text').placeholder = '# Инструкции проекта\n\n## Тесты\nnode --test\n\n## Требования\nСохраняй существующие пользовательские изменения.\n';
    setText('instructions-note', snapshot ? 'Снимок ' + file.path + ', использованный в этом запуске.'
      : file.path + ' в рабочей папке. Изменения применяются со следующего запуска задачи.');
    $('save-instructions').hidden = Boolean(snapshot);
    $('instructions-error').hidden = true;
    $('instructions-dialog').showModal();
  } catch (error) { toast(error); }
}
$('project-instructions').addEventListener('click', () => openInstructions());
$('instructions-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = instructionsTarget;
  if (!target || target.snapshot) return;
  try {
    await api.saveInstructions(target.chatId, $('instructions-text').value, target.file.stamp, target.file.path);
    contextKey = ''; renderIntelligence();
    $('instructions-dialog').close(); refreshWorkspace();
  } catch (error) { setText('instructions-error', errorText(error)).hidden = false; }
});

async function changeTaskOptions() {
  try { updateState(await api.taskOptions(state.activeChat, { approval: $('approval-mode').value, planning: $('use-plan').checked })); }
  catch (error) { toast(error); renderComposer(); }
}
$('approval-mode').addEventListener('change', changeTaskOptions);
$('use-plan').addEventListener('change', changeTaskOptions);

function planEditorRow(step = { title: '', kind: 'other' }) {
  const row = element('div', 'plan-editor-row');
  const title = element('input'); title.value = step.title; title.maxLength = 240; title.required = true; title.setAttribute('aria-label', 'Шаг плана');
  const kind = element('select'); kind.setAttribute('aria-label', 'Тип шага');
  for (const [id, label] of [['inspect', 'Изучение'], ['edit', 'Изменение'], ['test', 'Тесты'], ['other', 'Другое']]) {
    const option = element('option', '', label); option.value = id; kind.append(option);
  }
  kind.value = step.kind;
  const remove = element('button', 'quiet', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Убрать шаг'); remove.addEventListener('click', () => row.remove());
  row.append(title, kind, remove); return row;
}
function editDraftPlan(manual = false) {
  const chat = activeChat();
  if (!chat || (!chat.draftPlan && !manual) || document.querySelector('dialog[open]')) return;
  planTarget = { chatId: chat.id, source: chat.draftPlan?.source ?? $('prompt').value.trim() };
  $('plan-editor').replaceChildren(...(chat.draftPlan?.steps ?? [{ title: '', kind: 'inspect' }]).map(planEditorRow));
  $('plan-error').hidden = true; $('task-plan-dialog').showModal();
}
$('edit-draft-plan').addEventListener('click', editDraftPlan);
$('add-plan-step').addEventListener('click', () => { if ($('plan-editor').children.length < 8) $('plan-editor').append(planEditorRow()); });
$('task-plan-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const steps = [...$('plan-editor').children].map(row => ({ title: row.querySelector('input').value, kind: row.querySelector('select').value }));
    updateState(await api.planTask(planTarget.chatId, planTarget.source, steps)); $('task-plan-dialog').close();
  } catch (error) { setText('plan-error', errorText(error)).hidden = false; }
});
$('prepare-plan').addEventListener('click', async () => {
  if (activeChat()?.draftPlan?.source === $('prompt').value.trim()) return editDraftPlan();
  try { updateState(await api.planTask(state.activeChat, $('prompt').value)); $('draft-plan-card').open = true; }
  catch (error) { editDraftPlan(true); setText('plan-error', errorText(error) + ' Можно задать шаги вручную.').hidden = false; }
});
$('create-task-branch').addEventListener('click', () => {
  $('task-branch-name').value = 'alice/task-' + state.activeChat.slice(0, 8);
  $('branch-error').hidden = true; $('task-branch-dialog').showModal();
});
$('task-branch-form').addEventListener('submit', async event => {
  event.preventDefault(); $('confirm-task-branch').disabled = true;
  try { updateState(await api.taskWorkspace(state.activeChat, $('task-branch-name').value.trim())); $('task-branch-dialog').close(); }
  catch (error) { setText('branch-error', errorText(error)).hidden = false; }
  finally { $('confirm-task-branch').disabled = false; }
});
async function showTransfer() {
  return showTransferV09();
}
$('transfer-task').addEventListener('click', showTransfer);
$('apply-task-transfer').addEventListener('click', async () => {
  return applyTransferV09();
});

api.state().then(updateState).catch(toast);
