'use strict';
const projectCommandLabels = { prepare: 'Подготовить ветку', install: 'Зависимости', types: 'Типы', test: 'Тесты', build: 'Сборка', start: 'Запустить' };
let workflowMode = null, workflowTaskId = null, selectedCommandId = null, commandOriginal = false, commandSettingsTarget;
const runLabels = { pending: 'Ожидает', in_progress: 'Выполняется', background: 'В фоне', completed: 'Готово', failed: 'Ошибка', interrupted: 'Прервано' };
function workflowView() { return { mode: workflowMode, messageId: workflowTaskId, commandId: selectedCommandId, original: commandOriginal }; }
function restoreWorkflow(view = {}) { workflowMode = ['task', 'commands', 'problems', 'context', 'api'].includes(view.mode) ? view.mode : null; workflowTaskId = view.messageId; selectedCommandId = view.commandId; commandOriginal = view.original === true; }
function openWorkflow(mode) { workflowMode = mode; renderWorkflow(); scheduleWorkspaceSave(); }
function workflowButton(label, action, className = 'quiet') { const b = element('button', className, label); b.type = 'button'; b.addEventListener('click', action); return b; }
function currentRoot(chat = activeChat()) { return chat?.workspace?.root ?? state.projects.find(p => p.id === chat?.projectId)?.path; }
function selectedCommand() { return state?.commandRuns?.find(run => run.id === selectedCommandId); }
function runIsActive(run) { return ['pending', 'in_progress', 'background'].includes(run.status); }
function profileControls(chat, original) {
  const host = element('div', 'profile-controls');
  const picker = element('select'); picker.setAttribute('aria-label','Профиль команд');
  for (const profile of state.profileSets[chat.projectId]) picker.add(new Option(profile.name, profile.id));
  picker.value = chat.profileId;
  picker.addEventListener('change', async () => {
    try { updateState(await api.selectCommandProfile(chat.id, picker.value)); } catch (error) { toast(error); }
  });
  const check = workflowButton('Проверить задачу', async () => {
    check.disabled = true;
    try { const run = await api.startCommand(chat.id, 'sequence', original); selectedCommandId = run.id; mergeCommand(run); openWorkflow('commands'); }
    catch (error) { toast(error); check.disabled = false; }
  });
  check.disabled = !state.projectProfiles[chat.projectId]?.sequence.length || state.commandRuns.some(run => run.chatId === chat.id && run.steps && runIsActive(run));
  check.title = original ? 'В исходной папке' : 'В рабочей папке чата';
  host.append(picker, check, workflowButton('Новый профиль', () => openCommandSettings(true)));
  return host;
}
function renderWorkflow() {
  if (!state) return;
  const chat = activeChat(), runs = (state.commandRuns ?? []).filter(run => run.chatId === chat?.id);
  for (const id of ['show-task', 'show-commands', 'project-command-settings', 'manage-task-branches']) $(id).disabled = !chat;
  const message = state.messages.find(m => m.id === workflowTaskId && m.task) ?? state.messages.filter(m => m.task).at(-1);
  const running = runs.filter(runIsActive);
  const taskStatus = state.busy === chat?.id ? state.permission ? 'Ждёт разрешения' : ({ plan: 'Составляет план', prepare: 'Готовит задачу', review: 'Сравнивает изменения' }[state.busyStage] ?? (running.length ? 'Выполняет команду' : 'Алиса работает')) : running.length ? 'Команд в работе: ' + running.length : message?.status === 'error' ? 'Задача завершилась с ошибкой' : message?.task?.status === 'done' ? 'Задача выполнена' : '';
  setText('task-live-status', taskStatus);
  setText('show-commands', 'Команды' + (running.length ? ' · ' + running.length : ''));
  $('task-drawer').hidden = !workflowMode || !chat;
  $('task-overview').hidden = workflowMode !== 'task'; $('command-console').hidden = workflowMode !== 'commands';
  if (typeof renderIntelligence === 'function') renderIntelligence();
  $('drawer-task-tab').classList.toggle('selected', workflowMode === 'task'); $('drawer-commands-tab').classList.toggle('selected', workflowMode === 'commands');
  setText('drawer-caption', chat?.workspace ? chat.workspace.branch : 'Исходная папка');
  if (workflowMode === 'task') {
    const host = $('task-overview'); host.replaceChildren();
    if (chat) host.append(profileControls(chat,false));
    const latest = runs.find(run => run.steps && run.profile?.id === chat?.profileId);
    if (latest) {
      const steps = element('div','profile-controls');
      steps.append(element('strong','',latest.profile.name + ' · ' + runLabels[latest.status]));
      for (const step of latest.steps) {
        const button = workflowButton(projectCommandLabels[step.key] + ' · ' + (runLabels[step.status] ?? 'Пропущено'), () => {
          selectedCommandId = step.runId; openWorkflow('commands');
        });
        button.disabled = !step.runId; steps.append(button);
      }
      steps.title = latest.cwd; host.append(steps);
    }
    if (!message) { host.append(element('p', 'muted', 'Поставьте задачу Алисе. Здесь появятся план, изменённые файлы и результаты проверок.')); return; }
    const plan = renderTask(message, true); host.append(plan);
    const results = element('div', 'task-results');
    if (typeof renderReviewNotes === 'function') renderReviewNotes(results, message, runs);
    results.append(element('strong', '', message.task.source));
    if (message.error) results.append(element('p', 'error', message.error));
    for (const file of message.review?.files ?? []) results.append(workflowButton(file.path, () => openReview(message, file.path)));
    const tests = (message.tools ?? []).filter(tool => tool.tests || tool.repeatable);
    for (const tool of tests) {
      const result = element('div', tool.exitCode === 0 ? 'test-success' : 'error', (tool.command ?? tool.title) + ' · ' + (tool.tests ? `${tool.tests.passed}/${tool.tests.total} тестов` : `код ${tool.exitCode ?? '—'}`));
      const run = runs.find(run => run.messageId === message.id && run.toolId === tool.id);
      if (run && !runIsActive(run) && typeof versionBadge === 'function') result.append(versionBadge(run));
      if (run) result.append(workflowButton('Вывод', () => { selectedCommandId = run.id; openWorkflow('commands'); }));
      if (run && !runIsActive(run)) result.append(workflowButton('Повторить', async () => { try { const next = await api.repeatCommand(run.id); selectedCommandId = next.id; mergeCommand(next); openWorkflow('commands'); } catch (error) { toast(error); } }));
      else if (tool.repeatable) result.append(workflowButton('Повторить', () => confirmReplay(message, tool)));
      results.append(result);
    }
    if (message.managedPaths?.length) results.append(workflowButton('Откатить правки…', () => openRollback(message)));
    host.append(results);
  } else if (workflowMode === 'commands') renderCommandConsole(runs);
}
function renderCommandConsole(runs) {
  const chat = activeChat(), profile = state.projectProfiles?.[chat.projectId] ?? { commands: {} };
  const launchers = $('command-launchers'); launchers.replaceChildren();
  launchers.append(profileControls(chat,commandOriginal));
  const location = element('label', 'check-label'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = commandOriginal;
  checkbox.addEventListener('change', () => { commandOriginal = checkbox.checked; renderWorkflow(); scheduleWorkspaceSave(); });
  if (chat.workspace) { location.append(checkbox, document.createTextNode('В исходной папке')); launchers.append(location); }
  for (const [key, label] of Object.entries(projectCommandLabels)) if (profile.commands[key]) {
    const button = workflowButton(label, async () => {
      button.disabled = true;
      try { const run = await api.startCommand(chat.id, key, commandOriginal); selectedCommandId = run.id; mergeCommand(run); }
      catch (error) { toast(error); } finally { button.disabled = false; }
    }); button.title = profile.commands[key]; launchers.append(button);
  }
  if (!Object.values(profile.commands).some(Boolean)) launchers.append(workflowButton('Настроить команды…', openCommandSettings));
  $('command-history').replaceChildren();
  if (!runs.some(run => run.id === selectedCommandId)) selectedCommandId = runs[0]?.id;
  for (const run of runs.slice(0, 100)) {
    const row = workflowButton('', () => { selectedCommandId = run.id; renderCommandConsole(runs); scheduleWorkspaceSave(); }, 'command-item' + (run.id === selectedCommandId ? ' selected' : ''));
    row.append(element('span', 'run-state run-' + run.status, runLabels[run.status] ?? run.status), element('span', 'command-name', (run.profile?.name ? run.profile.name + ' · ' : '') + run.command)); row.title = run.cwd; $('command-history').append(row);
  }
  const run = runs.find(run => run.id === selectedCommandId);
  const heading = $('command-heading'); heading.replaceChildren(); $('command-links').replaceChildren();
  if (!run) { setText('command-location', 'Запуски команд проекта и действия Алисы появятся здесь.'); setText('command-output', ''); return; }
  heading.append(element('strong', '', run.command), element('span', 'run-state run-' + run.status, runLabels[run.status] ?? run.status),
    element('small', '', `${Math.round((run.elapsedMs ?? 0) / 1000)} с` + (Number.isInteger(run.exitCode) ? ' · код ' + run.exitCode : '')));
  if (runIsActive(run)) heading.append(workflowButton(run.source === 'agent' ? 'Остановить задачу' : 'Остановить', () => api.stopCommand(run.id).catch(toast)));
  else heading.append(workflowButton('Повторить', async () => { try { const next = await api.repeatCommand(run.id); selectedCommandId = next.id; mergeCommand(next); } catch (error) { toast(error); } }));
  heading.append(workflowButton('В чат', () => {
    if (run.chatId !== state.activeChat) return;
    $('prompt').value = ($('prompt').value ? $('prompt').value + '\n\n' : '') + `Разбери результат команды ${JSON.stringify(run.command)} в ${JSON.stringify(run.cwd)}. Статус: ${runLabels[run.status] ?? run.status}, код: ${run.exitCode ?? 'нет'}.\n\n` + run.output.slice(-12000);
    $('prompt').dispatchEvent(new Event('input', { bubbles: true })); $('prompt').focus();
  }));
  setText('command-location', run.cwd + ' · ' + (run.source === 'agent' ? 'Алиса' : 'Команда проекта') + (run.error ? ' · ' + run.error : ''));
  for (const step of run.steps ?? []) {
    const button = workflowButton(projectCommandLabels[step.key] + ' · ' + (runLabels[step.status] ?? 'Пропущено'), () => {
      selectedCommandId = step.runId; renderCommandConsole(runs);
    });
    button.disabled = !step.runId; $('command-links').append(button);
  }
  if (typeof versionBadge === 'function' && isCheck(run)) heading.append(versionBadge(run));
  const output = $('command-output'), atEnd = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
  output.textContent = (run.truncated ? '… Начало вывода сокращено\n' : '') + run.output;
  if (atEnd) output.scrollTop = output.scrollHeight;
  const linked = new Set();
  for (const match of run.output.matchAll(/(?:file:\/\/\/)?((?:[A-Za-z]:[\\/]|(?:src|test|tests|app|pages|lib|components)[\\/])[^\s():]+):(\d+)(?::\d+)?/g)) {
    let path = match[1]; try { path = decodeURIComponent(path); } catch {}
    path = path.replaceAll('\\', '/'); const root = run.root.replaceAll('\\', '/');
    if (!/^[a-z]:/i.test(path) && !path.startsWith('/')) path = run.cwd.replaceAll('\\','/').replace(/\/$/,'') + '/' + path;
    if (!path.toLowerCase().startsWith(root.toLowerCase() + '/')) continue;
    path = path.slice(root.length + 1);
    const key = path + ':' + match[2]; if (linked.has(key) || linked.size > 12) continue; linked.add(key);
    $('command-links').append(workflowButton(key, () => {
      if (currentRoot()?.toLowerCase() !== run.root.toLowerCase()) return toast('Файл относится к другой рабочей папке задачи.');
      showInspector(true); openEditor(path, Number(match[2]));
    }));
  }
}
function mergeCommand(run) {
  if (!state) return;
  state.commandRuns ??= []; const index = state.commandRuns.findIndex(item => item.id === run.id);
  if (index === -1) state.commandRuns.unshift(run); else state.commandRuns[index] = run;
  renderWorkflow();
}
api.onCommand(mergeCommand);
$('show-task').addEventListener('click', () => { workflowTaskId = null; openWorkflow(workflowMode === 'task' ? null : 'task'); });
$('show-commands').addEventListener('click', () => openWorkflow(workflowMode === 'commands' ? null : 'commands'));
$('drawer-task-tab').addEventListener('click', () => openWorkflow('task'));
$('drawer-commands-tab').addEventListener('click', () => openWorkflow('commands'));
$('close-drawer').addEventListener('click', () => openWorkflow(null));
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.code === 'Backquote' && !document.querySelector('dialog[open]')) { event.preventDefault(); openWorkflow(workflowMode === 'commands' ? null : 'commands'); }
});
function openCommandSettings(create = false) {
  const chat = activeChat(); if (!chat || document.querySelector('dialog[open]')) return;
  const profile = create === true ? { id: crypto.randomUUID(), commands: {} } : state.projectProfiles[chat.projectId];
  commandSettingsTarget = { chatId: chat.id, id: profile.id };
  $('profile-name').value = profile.name ?? ''; $('profile-name').readOnly = profile.id === 'all';
  $('profile-scope').value = (profile.scope ?? []).join('\n');
  $('profile-sequence').replaceChildren(...[0,1,2].map(i => {
    const select = element('select'); select.setAttribute('aria-label','Шаг ' + (i+1));
    select.add(new Option('—',''));
    for (const key of ['types','test','build']) select.add(new Option(projectCommandLabels[key],key));
    select.value = profile.sequence?.[i] ?? ''; return select;
  }));
  $('command-directory').value = profile.directory ?? ''; $('command-runtime').value = profile.runtime ?? '';
  $('command-settings-fields').replaceChildren();
  for (const [key, label] of Object.entries(projectCommandLabels)) {
    const row = element('label', 'command-setting', label); const input = element('input'); input.id = 'project-command-' + key; input.value = profile.commands[key] ?? ''; input.maxLength = 3000;
    input.placeholder = ({ prepare: 'npm ci', install: 'npm ci', types: 'npm run typecheck', test: 'npm test', build: 'npm run build', start: 'npm start' })[key]; row.append(input); $('command-settings-fields').append(row);
  }
  $('commands-error').hidden = true; $('commands-dialog').showModal();
}
$('project-command-settings').addEventListener('click', openCommandSettings);
$('commands-form').addEventListener('submit', async event => {
  event.preventDefault(); const value = { directory: $('command-directory').value, runtime: $('command-runtime').value,
    id: commandSettingsTarget.id, name: $('profile-name').value, scope: $('profile-scope').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
    commands: Object.fromEntries(Object.keys(projectCommandLabels).map(key => [key, $('project-command-' + key).value])) };
  const steps = [...$('profile-sequence').children].map(select=>select.value).filter(Boolean);
  if (steps.length) value.sequence = steps;
  try { updateState(await api.saveProjectCommands(commandSettingsTarget.chatId, value)); $('commands-dialog').close(); }
  catch (error) { setText('commands-error', errorText(error)).hidden = false; }
});
async function showBranches() {
  if (!document.querySelector('dialog[open]')) $('branches-dialog').showModal();
  $('branch-list').replaceChildren(element('p', 'muted', 'Проверяем рабочие папки…')); $('branches-error').hidden = true;
  try {
    const workspaces = await api.taskWorkspaces(); $('branch-list').replaceChildren();
    if (!workspaces.length) $('branch-list').append(element('p', 'muted', 'Рабочих папок задач пока нет. Создайте отдельную ветку в новом чате.'));
    for (const item of workspaces) {
      const row = element('article', 'branch-card');
      row.dataset.workspaceId = item.id;
      const project = state.projects.find(project => project.id === item.projectId), chat = state.chats.find(chat => chat.id === item.chatId);
      row.append(element('strong', '', item.branch), element('span', 'muted', project?.title ?? 'Проект'), element('p', 'branch-path', item.directory),
        element('p', 'muted', item.state === 'removed' ? 'Рабочая папка удалена · Git-ветка сохранена' : `${item.bytes == null ? '' : (item.bytes / 1048576).toFixed(1) + ' МБ' + (item.incomplete ? '+' : '') + ' · '}${chat?.title ?? 'Чат удалён'}${item.note ? ' · ' + item.note : ''}`));
      if (chat) row.append(workflowButton('Открыть чат', async () => { $('branches-dialog').close(); await select(chat.id); }));
      if (item.exists) row.append(workflowButton('В Проводнике', () => api.revealTaskWorkspace(item.id).catch(toast)));
      if (item.exists && item.state !== 'removed') {
        const clean = workflowButton('Завершить и удалить папку', async () => {
          clean.disabled = true;
          try { const flushed = api.flushWorkspace(workspaceValues()); if (flushed.error) throw new Error(flushed.error); updateState(await api.removeTaskWorkspace(item.id)); await showBranches(); }
          catch (error) { setText('branches-error', errorText(error)).hidden = false; clean.disabled = false; }
        }); clean.disabled = !item.removable; row.append(clean);
      }
      $('branch-list').append(row);
    }
  } catch (error) { setText('branches-error', errorText(error)).hidden = false; }
}
$('manage-task-branches').addEventListener('click', showBranches);
if (state) { restoreWorkflow(chatViews.get(state.activeChat)?.workflow); renderWorkflow(); }
setInterval(() => {
  const run = selectedCommand();
  if (workflowMode === 'commands' && run && runIsActive(run)) {
    const elapsed = $('command-heading').querySelector('small'); if (elapsed) elapsed.textContent = Math.round((Date.now() - run.startedAt) / 1000) + ' с';
  }
}, 1000);

async function showTransferV09() {
  const target = transferTarget = { chatId: state.activeChat, token: null, files: [], resolutions: {} };
  $('apply-task-transfer').disabled = true; $('transfer-files').replaceChildren();
  setText('transfer-note', 'Сравниваем результат с исходным проектом…'); $('task-transfer-dialog').showModal();
  try {
    const result = await api.transferPreview(target.chatId); if (target !== transferTarget) return;
    target.token = result.token; target.files = result.files;
    setText('transfer-note', result.files.length ? 'Выберите файлы для переноса. Разрешите выбранные конфликты в поле результата. Исходный индекс Git сохраняется.' : 'Изменений задачи нет.');
    for (const file of result.files) {
      const group = element('details', 'transfer-file'); group.open = Boolean(file.conflict);
      const summary = element('summary'), label = element('label', 'check-label'), check = element('input'); check.type = 'checkbox'; check.checked = file.changed || Boolean(file.conflict); check.dataset.transferPath = file.path;
      check.addEventListener('click', event => event.stopPropagation()); check.addEventListener('change', refreshTransferSelection);
      label.append(check, document.createTextNode(file.path + (file.conflict ? ' · конфликт' : file.changed ? '' : ' · уже перенесено'))); summary.append(label); group.append(summary);
      if (file.conflict && file.resolvable) {
        const versions = element('div', 'merge-versions');
        for (const [label, text] of [['Начало задачи', file.base], ['Ваш текущий файл', file.current], ['Результат Алисы', file.desired]]) {
          const pane = element('div'); pane.append(element('strong', '', label), element('pre', 'context-text', text ?? '(файла не было)')); versions.append(pane);
        }
        const resultLabel = element('label', 'merge-result-label', 'Результат переноса — отредактируйте и отметьте готовность');
        const editor = element('textarea', 'merge-result'); editor.value = file.conflict; editor.spellcheck = false; editor.setAttribute('aria-label', 'Результат слияния ' + file.path); editor.dataset.mergePath = file.path;
        const readyLabel = element('label', 'check-label'), ready = element('input'); ready.type = 'checkbox'; ready.dataset.resolvedPath = file.path;
        readyLabel.append(ready, document.createTextNode('Конфликт разрешён'));
        const changed = () => { if (ready.checked) target.resolutions[file.path] = editor.value; else delete target.resolutions[file.path]; refreshTransferSelection(); };
        editor.addEventListener('input', changed); ready.addEventListener('change', changed);
        const choose = (text) => { editor.value = text; ready.checked = true; changed(); };
        group.append(versions, workflowButton('Оставить мой файл', () => choose(file.current)), workflowButton('Взять файл Алисы', () => choose(file.desired)), resultLabel, editor, readyLabel);
      } else group.append(element('pre', 'context-text', file.conflict ?? (file.patch || (file.changed ? 'Создание или удаление пустого файла.' : 'Изменение уже перенесено.'))));
      $('transfer-files').append(group);
    }
    refreshTransferSelection();
  } catch (error) { setText('transfer-note', errorText(error)); }
}
function transferSelection() { return [...$('transfer-files').querySelectorAll('[data-transfer-path]:checked')].map(input => input.dataset.transferPath); }
function refreshTransferSelection() {
  const target = transferTarget, paths = transferSelection();
  $('apply-task-transfer').disabled = !target?.token || !paths.length || target.files.some(file => paths.includes(file.path) && file.conflict && (!Object.hasOwn(target.resolutions, file.path) || /^(<<<<<<< |\|\|\|\|\|\|\| |=======$|>>>>>>> )/m.test(target.resolutions[file.path])));
}
async function applyTransferV09() {
  const target = transferTarget, selection = transferSelection(); $('apply-task-transfer').disabled = true;
  try {
    const files = await api.transferTask(target.chatId, target.token, selection, target.resolutions);
    setText('transfer-note', 'Перенесено файлов: ' + files.length + '. Исходный индекс Git сохранён.'); target.token = null;
    $('transfer-files').querySelectorAll('input,textarea,button').forEach(control => { control.disabled = true; });
    const test = state.projectProfiles?.[activeChat().projectId]?.commands.test;
    if (test) $('transfer-files').prepend(workflowButton('Проверить тесты в исходном проекте', async () => {
      try { const run = await api.startCommand(target.chatId, 'test', true); selectedCommandId = run.id; mergeCommand(run); $('task-transfer-dialog').close(); openWorkflow('commands'); } catch (error) { toast(error); }
    }));
  } catch (error) { setText('transfer-note', errorText(error) + ' Закройте и откройте перенос заново.'); }
}
