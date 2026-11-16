'use strict';

const api = window.alicecode;
const $ = id => document.getElementById(id);
const statusLabels = {
  pending: 'Ожидает', in_progress: 'Выполняется', completed: 'Готово', failed: 'Ошибка',
};
const drafts = new Map();
const openTools = new Set();
let state;
let workspace;
let workspaceRequest = 0;
let tab = 'files';
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
    for (const chat of chats) {
      const item = element('button', 'chat-item', chat.title);
      item.title = chat.title;
      item.setAttribute('aria-current', String(chat.id === state.activeChat));
      item.addEventListener('click', () => select(chat.id));
      const chatRow = element('div', 'nav-row chat-row');
      chatRow.append(item, renameButton('chat', chat));
      group.append(chatRow);
    }
    tree.append(group);
  }
}

function findReference(value, paths) {
  let normalized = value;
  try { normalized = decodeURIComponent(value); } catch {}
  normalized = normalized.replaceAll('\\', '/').replace(/^file:\/\/\//i, '')
    .replace(/^\/(?=[a-z]:\/)/i, '').replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '');
  const project = state.projects.find(item => item.id === activeChat()?.projectId);
  const root = project && project.path.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  if (root && normalized.toLowerCase().startsWith(root.toLowerCase())) normalized = normalized.slice(root.length);
  const direct = paths.find(path => path.toLowerCase() === normalized.toLowerCase());
  if (direct || normalized.includes('/') || normalized.includes(':')) return direct;
  const matches = paths.filter(path => path.toLowerCase().split('/').at(-1) === normalized.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

function fileLink(path, label = path, preferDiff = false) {
  const button = element('button', 'file-link', label);
  button.type = 'button';
  button.title = path;
  button.addEventListener('click', () => openPreview(path, preferDiff || workspace?.changes.some(change => change.path === path)
    ? 'changes' : 'files'));
  return button;
}

function formatMessage(text, paths = [], changed = []) {
  const container = element('div', 'message-text');
  const parts = text.split(/(?:^|\n)```[^\n]*\n|\n```(?=\n|$)/);
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      container.append(element('pre', '', part));
      continue;
    }
    let end = 0;
    const tokens = /\[([^\]\n]+)\]\(([^\n)]+)\)|`([^`\n]+)`|(?<![\p{L}\p{N}_.])([\p{L}\p{N}_./\\-]+\.[\p{L}\p{N}_-]{1,15})(?=[\s,.:;!?()[\]]|$)/gu;
    for (const match of part.matchAll(tokens)) {
      const [, label, target, code, bare] = match;
      container.append(document.createTextNode(part.slice(end, match.index)));
      const reference = findReference(target ?? code ?? bare, paths) ?? (label && findReference(label, paths));
      if (reference) container.append(fileLink(reference, label ?? code ?? bare, changed.includes(reference)));
      else if (code) container.append(element('code', '', code));
      else container.append(document.createTextNode(label ?? bare));
      end = match.index + match[0].length;
    }
    container.append(document.createTextNode(part.slice(end)));
  }
  return container;
}

function actionOutcome(tool) {
  if (tool.decision === 'denied') return ['Отклонено', 'failed'];
  if (tool.interrupted) return ['Прервано', 'failed'];
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
  const testRuns = commands.filter(tool => tool.tests || /\b(?:node\s+--test|npm\s+(?:run\s+)?test|pytest|vitest|jest|cargo\s+test|go\s+test)\b/.test(executedCommand(tool)));
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
      row.append(element('span', `outcome ${tone}`, label));
      runs.append(row);
    }
    panel.append(runs);
  }
  if (paths.length) {
    const files = element('div', 'work-files');
    for (const path of paths) files.append(fileLink(path, path, true));
    panel.append(files);
  }
  const journal = disclosure(`${message.id}:journal`, `Журнал действий · ${tools.length}`);
  const list = element('div', 'tool-list');
  for (const tool of tools) {
    const details = disclosure(`${message.id}:${tool.id}`, executedCommand(tool) ?? tool.title);
    const [label, tone] = actionOutcome(tool);
    details.querySelector('summary').append(element('span', `outcome ${tone}`, label));
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
    return row;
  }
  const role = element('div', 'message-role');
  const mark = element('span', 'mark');
  mark.setAttribute('aria-hidden', 'true');
  role.append(mark, document.createTextNode('Алиса'));
  if (message.modelId) role.append(element('span', 'model-label',
    state.models.find(model => model.id === message.modelId)?.label ?? message.modelId));
  row.append(role);
  const paths = [...new Set(message.tools.filter(tool => tool.status === 'completed' && tool.decision !== 'denied')
    .flatMap(tool => tool.paths ?? []))];
  const references = [...new Set([...paths, ...(workspace?.files ?? []), ...(workspace?.changes ?? []).map(item => item.path)])];
  if (message.tools.length) row.append(workSummary(message, paths));
  row.append(formatMessage(message.text, references, paths));
  if (message.error) row.append(element('p', 'error', message.error));
  if (message.status === 'cancelled') row.append(element('p', 'busy-text', 'Задача остановлена.'));
  if (message.status === 'running' && !message.text) row.append(element('p', 'busy-text', 'Алиса работает…'));
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
  $('composer-area').hidden = !chat;
  $('stop').hidden = state.busy !== chat?.id;
  const permission = state.permission;
  $('permission').hidden = !permission || permission.chatId !== chat?.id;
  renderPermission($('permission').hidden ? null : permission);
  const available = state.models.some(model => model.id === (chat?.modelId ?? state.defaultModel));
  const notice = !state.configured ? state.credentialError ?? 'Подключите ключ Yandex AI Studio в настройках.'
    : chat && !available ? 'Модель отсутствует в каталоге. Выберите другую.'
    : state.busy && state.busy !== chat?.id ? 'Алиса работает в другом чате.' : '';
  setText('notice', notice).hidden = !notice;
  $('prompt').disabled = !state.configured;
  $('send').disabled = !chat || !state.configured || !available || Boolean(state.busy) || !$('prompt').value.trim();
}

function renderModels() {
  const chat = activeChat();
  const current = chat?.modelId ?? state.defaultModel;
  const picker = $('model');
  picker.replaceChildren();
  for (const model of state.models) {
    const option = element('option', '', model.label);
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
  picker.disabled = !chat || !state.configured || state.busy === chat.id;
  $('provider').classList.toggle('connected', state.configured);
  picker.title = state.configured ? 'Выбрать модель для этого чата' : 'API-ключ не настроен';
  setText('catalog-status', !state.configured ? 'Сохраните ключ, чтобы загрузить список.'
    : state.catalogStatus === 'loading' ? 'Загружаем модели…'
      : state.catalogStatus === 'error' ? 'Каталог недоступен. Показаны поддерживаемые модели.'
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
  const previous = state;
  const changed = previous?.activeChat !== next.activeChat;
  if (changed && previous?.activeChat) drafts.set(previous.activeChat, $('prompt').value);
  state = next;
  if (!layout) {
    layout = { ...state.layout };
    showInspector(layout.inspectorVisible, false);
  }
  if (changed) {
    $('prompt').value = drafts.get(state.activeChat) ?? '';
    workspace = undefined;
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
  renderModels();
  renderNavigation();
  renderComposer();
  renderThread(changed);
  renderUpdates();
  if (changed || previous?.busy && !state.busy) refreshWorkspace();
  else if (!previous) renderWorkspace();
}

async function select(chatId) {
  if (!chatId || chatId === state.activeChat) return;
  try { updateState(await api.selectChat(chatId)); } catch (error) { toast(error); }
}

async function selectProject(projectId) {
  if (!projectId || activeChat()?.projectId === projectId) return;
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
    const location = [kind, result.kind !== 'project' && result.projectTitle,
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
      const results = await api.search(query);
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
  $('files-tab').setAttribute('aria-selected', String(tab === 'files'));
  $('changes-tab').setAttribute('aria-selected', String(tab === 'changes'));
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
    inspector: preview ? compact ? 280 : Math.max(340, Math.min(580, window.innerWidth * .33))
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
  $('inspector').classList.toggle('reviewing', Boolean(preview));
  renderLayout();
  if (!preview) return;
  setText('preview-title', preview.path).title = preview.path;
  setText('preview-mode', preview.mode === 'changes' ? 'Изменения в Git' : 'Файл');
  const body = $('preview-content');
  body.setAttribute('aria-label', preview.mode === 'changes' ? 'Изменения файла' : 'Содержимое файла');
  body.replaceChildren();
  if (preview.loading || preview.error || !preview.text) {
    body.textContent = preview.loading ? 'Загрузка…' : preview.error
      ?? (preview.mode === 'changes' ? 'Изменений для этого файла нет.' : 'Пустой файл.');
    return;
  }

  const lines = preview.text.replace(/\r?\n$/, '').split(/\r?\n/);
  let number = preview.mode === 'files' ? 1 : null;
  for (const line of lines.slice(0, 3000)) {
    let tone = '';
    let label = '';
    if (preview.mode === 'changes') {
      const hunk = /^@@ .+ \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        number = Number(hunk[1]);
        tone = 'diff-info';
      } else if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) {
        tone = 'diff-info';
      } else if (line.startsWith('-')) {
        tone = 'diff-remove';
      } else if (line.startsWith('+') || line.startsWith(' ')) {
        tone = line.startsWith('+') ? 'diff-add' : '';
        if (number !== null) label = String(number++);
      }
    } else {
      label = String(number++);
    }
    const row = element('span', `code-line ${tone}`);
    const gutter = element('span', 'line-number', label);
    gutter.setAttribute('aria-hidden', 'true');
    row.append(gutter, element('span', '', line), document.createTextNode('\n'));
    body.append(row);
  }
  if (lines.length > 3000) body.append(element('span', 'code-line diff-info', 'Показаны первые 3 000 строк.'));
}

async function openPreview(path, mode) {
  if (!state.activeChat) return;
  const id = ++previewRequest;
  if (!layout.inspectorVisible) showInspector(true);
  selectTab(mode);
  preview = { path, mode, loading: true };
  renderPreview();
  renderWorkspace();
  try {
    const text = await (mode === 'changes' ? api.readDiff : api.readFile)(state.activeChat, path);
    if (id !== previewRequest) return;
    preview = { path, mode, text };
  } catch (error) {
    if (id !== previewRequest) return;
    preview = { path, mode, error: errorText(error) };
  }
  renderPreview();
}

function closePreview() {
  previewRequest++;
  preview = undefined;
  renderPreview();
  renderWorkspace();
}

function renderWorkspace() {
  const root = $('workspace');
  root.replaceChildren();
  const count = workspace?.changes.length ?? 0;
  setText('changes-count', String(count)).hidden = !count;
  if (!state.activeChat || !workspace) {
    root.append(element('p', '', state.activeChat ? 'Загружаем папку…' : 'Выберите проект.'));
    return;
  }
  if (workspace.error) {
    root.append(element('p', '', workspace.error));
    return;
  }
  const rows = tab === 'files' ? workspace.files : workspace.changes;
  if (!rows.length) root.append(element('p', '', tab === 'files' ? 'Папка пуста.' : 'Изменений в Git нет.'));
  for (const item of rows) {
    const path = item.path ?? item;
    const button = element('button', 'file');
    button.title = path;
    button.setAttribute('aria-current', String(preview?.path === path && preview.mode === tab));
    if (item.status) {
      const [icon, title] = ({ A: ['+', 'Добавлен'], '?': ['+', 'Новый'], D: ['−', 'Удалён'] })[item.status]
        ?? ['~', 'Изменён'];
      const badge = element('span', `file-status status-${item.status === 'D' ? 'deleted' : item.status === 'M' ? 'modified' : 'added'}`, icon);
      badge.title = title;
      badge.setAttribute('aria-label', title);
      button.append(badge);
    }
    button.append(element('span', 'file-path', path));
    button.addEventListener('click', () => openPreview(path, tab));
    root.append(button);
  }
}

async function refreshWorkspace() {
  const request = ++workspaceRequest;
  renderWorkspace();
  if (!state.activeChat) return;
  let result;
  try { result = await api.inspectProject(state.activeChat); }
  catch (error) { result = { files: [], changes: [], error: errorText(error) }; }
  if (request !== workspaceRequest) return;
  workspace = result;
  renderWorkspace();
  renderThread(false);
  if (preview) openPreview(preview.path, preview.mode);
}

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
  setText('settings-status', state.configured ? 'Ключ сохранён для вашей учётной записи Windows.'
    : state.credentialError ?? 'Подключите Alice AI LLM Flash.');
  $('settings-dialog').showModal();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('save-settings').disabled = true;
  try {
    updateState(await api.saveKey({ folderId: $('folder-id').value.trim(), apiKey: $('api-key').value }));
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
$('prompt').addEventListener('input', renderComposer);
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
  $('prompt').value = '';
  renderComposer();
  try { await api.send(chatId, input); }
  catch (error) {
    if (state.activeChat === chatId && !$('prompt').value) $('prompt').value = input;
    toast(error);
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
  }
});
$('close-preview').addEventListener('click', closePreview);
for (const name of ['files', 'changes']) {
  $(`${name}-tab`).addEventListener('click', () => {
    if (tab !== name) closePreview();
    selectTab(name);
    refreshWorkspace();
  });
}
api.state().then(updateState).catch(toast);
