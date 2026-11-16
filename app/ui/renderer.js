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
let createParent;
let toastTimer;

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
    title.addEventListener('click', () => select(chats.some(chat => chat.id === state.activeChat)
      ? state.activeChat : chats[0]?.id));
    group.append(title);
    for (const chat of chats) {
      const item = element('button', 'chat-item', chat.title);
      item.title = chat.title;
      item.setAttribute('aria-current', String(chat.id === state.activeChat));
      item.addEventListener('click', () => select(chat.id));
      group.append(item);
    }
    tree.append(group);
  }
}

function formatMessage(text) {
  const container = element('div', 'message-text');
  const parts = text.split(/(?:^|\n)```[^\n]*\n|\n```(?=\n|$)/);
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      container.append(element('pre', '', part));
      continue;
    }
    const source = part.replace(/\[([^\]\n]+)\]\([^\n)]+\)/g, '$1');
    for (const [index, segment] of source.split('`').entries()) {
      container.append(index % 2 ? element('code', '', segment) : document.createTextNode(segment));
    }
  }
  return container;
}

function renderMessage(message) {
  const row = element('article', `message ${message.role}`);
  row.dataset.messageId = message.id;
  if (message.role === 'user') {
    row.setAttribute('aria-label', 'Вы');
    row.append(formatMessage(message.text));
    return row;
  }
  const role = element('div', 'message-role');
  const mark = element('span', 'mark');
  mark.setAttribute('aria-hidden', 'true');
  role.append(mark, document.createTextNode('Алиса'));
  row.append(role);
  if (message.tools.length) {
    const list = element('div', 'tool-list');
    for (const tool of message.tools) {
      const details = element('details');
      const key = `${message.id}:${tool.id}`;
      details.open = openTools.has(key);
      details.addEventListener('toggle', () => {
        if (details.open) openTools.add(key);
        else openTools.delete(key);
      });
      const summary = element('summary', '', tool.title);
      summary.append(element('span', 'tool-status', statusLabels[tool.status] ?? ''));
      details.append(summary);
      if (tool.output) details.append(element('pre', 'tool-output', tool.output));
      list.append(details);
    }
    row.append(list);
  }
  row.append(formatMessage(message.text));
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
  if (!$('permission').hidden) {
    setText('permission-title', permission.title);
    setText('permission-input', permission.input).hidden = !permission.input;
  }
  const notice = !state.configured ? state.credentialError ?? 'Подключите ключ Yandex AI Studio в настройках.'
    : state.busy && state.busy !== chat?.id ? 'Алиса работает в другом чате.' : '';
  setText('notice', notice).hidden = !notice;
  $('prompt').disabled = !state.configured;
  $('send').disabled = !chat || !state.configured || Boolean(state.busy) || !$('prompt').value.trim();
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
  if (changed) {
    $('prompt').value = drafts.get(state.activeChat) ?? '';
    workspace = undefined;
  }
  const chat = activeChat();
  const project = state.projects.find(item => item.id === chat?.projectId);
  setText('project-title', project?.title ?? 'Рабочее пространство').title = project?.path ?? '';
  setText('chat-title', chat?.title ?? '').title = chat?.title ?? '';
  $('new-chat').hidden = !chat;
  $('reveal').disabled = !chat;
  $('provider').classList.toggle('connected', state.configured);
  $('provider').title = state.configured ? 'Ключ Yandex AI Studio настроен' : 'API-ключ не настроен';
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

function showPreview(name, text, diff = false) {
  setText('preview-title', name);
  const preview = $('preview-content');
  preview.textContent = diff ? '' : text;
  if (diff) {
    for (const line of text.split('\n')) {
      const style = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : '';
      preview.append(element('span', style, line), document.createTextNode('\n'));
    }
  }
  $('preview-dialog').showModal();
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
    const button = element('button', 'file', item.name ?? item);
    button.title = item.name ?? item;
    button.addEventListener('click', async () => {
      try {
        if (tab === 'files') showPreview(item, await api.readFile(state.activeChat, item));
        else showPreview(item.name, item.diff, true);
      } catch (error) { toast(error); }
    });
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
}

api.onState(updateState);
api.onUpdate(update => {
  if (!state) return;
  state.updates = update;
  renderUpdates();
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
$('new-chat').addEventListener('click', async () => {
  try {
    updateState(await api.newChat(activeChat().projectId));
    $('prompt').focus();
  } catch (error) { toast(error); }
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
$('allow').addEventListener('click', () => api.permission(true).catch(toast));
$('deny').addEventListener('click', () => api.permission(false).catch(toast));
$('reveal').addEventListener('click', async () => {
  try {
    const error = await api.revealProject(state.activeChat);
    if (error) toast(error);
  } catch (error) { toast(error); }
});
$('toggle-inspector').addEventListener('click', () => {
  $('inspector').hidden = !$('inspector').hidden;
  $('toggle-inspector').setAttribute('aria-expanded', String(!$('inspector').hidden));
});
for (const name of ['files', 'changes']) {
  $(`${name}-tab`).addEventListener('click', () => {
    tab = name;
    $('files-tab').setAttribute('aria-selected', String(tab === 'files'));
    $('changes-tab').setAttribute('aria-selected', String(tab === 'changes'));
    refreshWorkspace();
  });
}
api.state().then(updateState).catch(toast);
