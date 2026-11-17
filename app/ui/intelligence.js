'use strict';
let navigationItems = [], navigationOrigin, navigationRoot, navigationBusy = false;
const navigationBack = [], selectedProblems = new Set(), openApiRows = new Set();
let analysisBusy = false, analysisRoot, contextKey = '', contextGeneration = 0, contextCache, summaryTarget, compressing = false, compressionMessage = '', changedCodeTimer;
function editorOverlays() { return [...(editorGroup()?.values() ?? [])].slice(0, 40).map(file => ({ path: file.path, text: file.text })); }
async function refreshCleanEditorBuffers() {
  const id = state.activeChat, files = editorGroup();
  for (const file of files?.values() ?? []) {
    if (file.dirty) continue;
    try {
      const fresh = await api.readEditor(id, file.path);
      if (state.activeChat !== id || files !== editorGroup()) throw new Error('Выбран другой чат.');
      if (file.dirty || fresh.stamp === file.stamp) continue;
      const position = editView === file ? editor.position() : {};
      Object.assign(file, fresh, { cleanText: fresh.text, dirty: false }, position);
      if (editView === file) showEditor(file, null, false);
    } catch (error) { if (state.activeChat !== id || files !== editorGroup()) throw error; }
  }
}
function changedCode() {
  const id = state.activeChat, root = currentRoot();
  if (state.analyses?.[root]) state.analyses[root].stale = true;
  clearTimeout(changedCodeTimer); changedCodeTimer = setTimeout(() => { changedCodeTimer = null; void api.staleAnalysis(id).catch(() => {}); }, 250);
  if (workflowMode === 'problems') renderProblems();
}
function navOrigin() { return editView && { root: currentRoot(), path: editView.path, ...editor.position() }; }
async function jumpToCode(item, remember = true) {
  if (navigationRoot && navigationRoot !== currentRoot()) return toast('Результат относится к другой рабочей папке.');
  const previous = navOrigin(); if (remember && previous) navigationBack.push(previous);
  showInspector(true); await openEditor(item.path, item.line, false);
  if (editView?.path === item.path && Number.isInteger(item.start)) editor.select(item.start, item.length ?? 0);
  editor?.focus(); $('code-navigation-dialog').close();
}
async function navigateCode(action) {
  if (!editView || !/\.[cm]?[jt]sx?$/i.test(editView.path) || navigationBusy) return toast('Откройте JS/TS-файл в редакторе.');
  navigationOrigin = navOrigin(); navigationRoot = currentRoot(); navigationBusy = true;
  try {
    await refreshCleanEditorBuffers();
    const result = await api.codeQuery(state.activeChat, action, { path: editView.path, position: editor.position().selection.head, overlays: editorOverlays() });
    if (navigationRoot !== currentRoot()) return;
    navigationItems = result.items;
    if (action === 'definition' && navigationItems.length === 1) return await jumpToCode(navigationItems[0]);
    setText('code-navigation-title', ({ definition: 'Определения', references: 'Использования', symbols: 'Символы файла' })[action]);
    $('code-navigation-filter').value = ''; setText('code-navigation-status', (result.limited ? 'Показана часть проекта. ' : '') + 'Найдено: ' + navigationItems.length);
    renderNavigationResults(); $('code-navigation-dialog').showModal(); $('code-navigation-filter').focus();
  } catch (error) { toast(error); } finally { navigationBusy = false; }
}
function renderNavigationResults() {
  const query = $('code-navigation-filter').value.toLowerCase(); $('code-navigation-results').replaceChildren();
  for (const item of navigationItems.filter(item => (item.name + ' ' + item.path).toLowerCase().includes(query))) {
    const button = workflowButton('', () => jumpToCode(item), 'code-location'); button.append(element('strong', '', item.name), element('span', 'muted', item.path + ':' + item.line)); $('code-navigation-results').append(button);
  }
}
$('code-navigation-filter').addEventListener('input', renderNavigationResults);
$('code-definition').addEventListener('click', () => navigateCode('definition'));
$('code-references').addEventListener('click', () => navigateCode('references'));
$('code-symbols').addEventListener('click', () => navigateCode('symbols'));
async function goCodeBack() { const item = navigationBack.pop(); if (!item) return; if (item.root !== currentRoot()) return toast('Предыдущая позиция находится в другой рабочей папке.'); navigationRoot = item.root; await jumpToCode({ path: item.path, start: item.selection.head }, false); }
$('code-back').addEventListener('click', goCodeBack);
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]') || !editView) return;
  if (event.key === 'F12') { event.preventDefault(); event.stopImmediatePropagation(); void navigateCode(event.shiftKey ? 'references' : 'definition'); }
  else if (event.ctrlKey && event.shiftKey && event.code === 'KeyO') { event.preventDefault(); void navigateCode('symbols'); }
  else if (event.altKey && event.code === 'ArrowLeft') { event.preventDefault(); void goCodeBack(); }
}, true);

function rootProblems() {
  const root = currentRoot(), analysis = state.analyses?.[root], problems = (analysis?.problems ?? []).map(problem => ({ ...problem, stale: analysis.stale }));
  const latest = new Map();
  for (const run of (state.commandRuns ?? []).filter(run => run.root === root && !runIsActive(run)).sort((a, b) => b.startedAt - a.startedAt)) if (!latest.has(run.command)) latest.set(run.command, run);
  for (const run of latest.values()) if (run.status === 'failed' || run.status === 'interrupted') problems.push({ source: run.source === 'agent' ? 'Команда Алисы' : 'Команда проекта', severity: 'error', runId: run.id,
    code: 'EXIT ' + (run.exitCode ?? '—'), message: run.command + (run.tests ? ` · тесты ${run.tests.passed}/${run.tests.total}` : ' · ' + runLabels[run.status]), stale: true });
  return problems;
}
function renderProblems() {
  if (!state || !activeChat()) return;
  const root = currentRoot(); if (analysisRoot !== root) { selectedProblems.clear(); analysisRoot = root; }
  const analysis = state.analyses?.[root], problems = rootProblems(); $('problems-list').replaceChildren();
  const valid = new Set(problems.map(problem => JSON.stringify(problem))); for (const key of selectedProblems) if (!valid.has(key)) selectedProblems.delete(key);
  $('analyze-project').disabled = analysisBusy;
  setText('problems-status', analysisBusy ? 'Проверяем JS/TS с учётом открытых буферов…' : !analysis ? 'Анализ ещё не запускался' : `${analysis.stale ? 'Результат устарел · ' : ''}TS ${analysis.version} · ${analysis.files} файлов · ${new Date(analysis.checkedAt).toLocaleTimeString()}${analysis.limited ? ' · анализ ограничен' : ''}`);
  if (analysis?.note) $('problems-list').append(element('p', 'panel-note', analysis.note));
  if (!problems.length) $('problems-list').append(element('p', 'panel-note', analysis && !analysis.stale ? analysis.limited ? 'В проверенной части ошибок не найдено. Анализ ограничен.' : 'Ошибок JS/TS не обнаружено. Результаты тестов и сборки проверяются отдельными командами.' : 'Обновите анализ, чтобы получить актуальный список проблем.'));
  for (const problem of problems) {
    const key = JSON.stringify(problem), row = element('div', 'problem-row'), control = element('input'); control.type = 'checkbox'; control.checked = selectedProblems.has(key); control.setAttribute('aria-label', 'Выбрать проблему');
    control.addEventListener('change', () => { if (control.checked) selectedProblems.add(key); else selectedProblems.delete(key); });
    const show = workflowButton('', async () => {
      if (problem.runId) { selectedCommandId = problem.runId; openWorkflow('commands'); }
      else if (problem.path) { navigationRoot = root; await jumpToCode(problem); }
    }, 'problem-location');
    show.append(element('span', 'problem-code', problem.code), document.createTextNode(problem.message), element('small', 'muted', [problem.path && problem.path + ':' + problem.line, problem.source, problem.stale ? 'Предыдущая проверка' : ''].filter(Boolean).join(' · ')));
    row.append(control, show); $('problems-list').append(row);
  }
}
$('analyze-project').addEventListener('click', async () => {
  if (analysisBusy) return; const id = state.activeChat; analysisBusy = true; renderProblems();
  try {
    if (changedCodeTimer) { clearTimeout(changedCodeTimer); changedCodeTimer = null; await api.staleAnalysis(id); }
    await refreshCleanEditorBuffers(); const data = await api.codeQuery(id, 'diagnostics', { overlays: editorOverlays() }); state.analyses ??= {}; state.analyses[data.root] = data;
  }
  catch (error) { toast(error); } finally { analysisBusy = false; renderProblems(); }
});
$('send-problems').addEventListener('click', () => {
  const problems = [...selectedProblems].map(key => JSON.parse(key)); if (!problems.length) return toast('Выберите проблемы в списке.');
  $('prompt').value = ($('prompt').value ? $('prompt').value + '\n\n' : '') + 'Разбери и исправь выбранные проблемы, затем повтори соответствующие проверки:\n' + problems.map(problem => `${problem.path ?? ''}:${problem.line ?? ''} ${problem.code}: ${problem.message}${problem.stale ? ' (предыдущая проверка — сначала проверь актуальность)' : ''}`).join('\n');
  $('prompt').dispatchEvent(new Event('input', { bubbles: true })); $('prompt').focus();
});
api.onAnalysis(data => { if (!state) return; state.analyses ??= {}; state.analyses[data.root] = data; if (workflowMode === 'problems') renderProblems(); });
api.onAnalysisStale(root => { if (state?.analyses?.[root]) { state.analyses[root].stale = true; if (workflowMode === 'problems') renderProblems(); } });

function contextStateKey() { const chat = activeChat(); return JSON.stringify([chat?.id, currentRoot(), chat?.pins, chat?.summary?.id, currentContext(), (externalDrafts.get(chat?.id) ?? []).map(file => file.id), editView?.path, $('prompt').value.slice(0, 500)]); }
async function refreshContextDetails() {
  const generation = ++contextGeneration, id = state.activeChat;
  try {
    const data = await api.contextDetails(id, currentContext(), (externalDrafts.get(id) ?? []).map(file => file.id), editView?.path ?? null, $('prompt').value);
    if (generation !== contextGeneration || state.activeChat !== id) return;
    contextCache = { ...data, chatId: id }; renderContextList();
  } catch (error) { if (generation === contextGeneration) setText('context-status', errorText(error)); }
}
function renderContextList() {
  if (!contextCache || contextCache.chatId !== state.activeChat) return;
  const data = contextCache, list = $('context-list'); list.replaceChildren();
  setText('context-status', compressionMessage || `${data.chars.toLocaleString()} символов в инструкциях, сводке и выбранных файлах. История агента учитывается в отчёте API.`);
  const block = (title, text) => { const node = element('details', 'context-block'); node.append(element('summary', '', title), element('pre', 'context-text', text || 'Нет')); list.append(node); };
  block('Инструкции · AGENTS.md', data.instructions.text);
  block('Сводка · ' + (data.summary ? new Date(data.summary.createdAt).toLocaleString() : 'ещё нет'), data.summary?.text);
  for (const [kind, refs] of [['pin', data.pins], ['draft', data.drafts]]) refs.forEach((ref, index) => {
    const row = element('div', 'context-ref' + (ref.stale ? ' stale' : ''));
    row.append(element('span', '', `${kind === 'pin' ? 'Закреплено' : 'В сообщении'} · ${ref.path}:${ref.start}–${ref.end}${ref.stale ? ' · изменилось, обновите' : ''}`));
    if (ref.error) row.append(element('small', 'muted', ref.error));
    if (kind === 'pin') {
      row.append(workflowButton('Обновить', async () => { try { updateState(await api.refreshPin(state.activeChat, index)); contextKey = ''; renderIntelligence(); } catch (error) { toast(error); } }), workflowButton('Открепить', async () => { updateState(await api.unpinContext(state.activeChat, index)); contextKey = ''; renderIntelligence(); }));
    } else row.append(workflowButton('Закрепить', async () => { try { updateState(await api.pinContext(state.activeChat, ref)); contextKey = ''; renderIntelligence(); } catch (error) { toast(error); } }), workflowButton('Убрать', () => { draftContexts.set(state.activeChat, currentContext().filter(item => item.digest !== ref.digest)); renderComposer(); contextKey = ''; renderIntelligence(); }));
    list.append(row);
  });
  for (const item of data.external) list.append(element('p', 'panel-note', 'Вложение в сообщении · ' + item.label + ' · ' + item.chars + ' символов'));
  if (data.references.length) block('Справочные вложения чата · доступны для чтения', data.references.map(item => item.label).join('\n'));
  for (const item of data.suggestions) {
    const row = element('div', 'context-ref'); row.append(element('span', '', item.path), element('small', 'muted', item.reason), workflowButton('Выбрать фрагмент', () => openFilePicker('attach', '', null, { path: item.path }))); list.append(row);
  }
}
$('refresh-context').addEventListener('click', refreshContextDetails);
$('compress-context').addEventListener('click', async () => {
  compressing = true; compressionMessage = 'Создаём сводку; файлы и история сохраняются…'; renderIntelligence();
  try { updateState(await api.compressContext(state.activeChat)); compressionMessage = 'Сводка сохранена. Следующий запуск использует свежую сессию модели.'; }
  catch (error) { compressionMessage = errorText(error); toast(error); }
  finally { compressing = false; contextKey = ''; renderIntelligence(); }
});
$('cancel-compression').addEventListener('click', () => api.cancelCompression());
$('edit-summary').addEventListener('click', () => {
  const chat = activeChat(); summaryTarget = { chatId: chat.id, id: chat.summary?.id ?? null }; $('summary-text').value = chat.summary?.text ?? '';
  $('summary-error').hidden = true; $('summary-dialog').showModal();
});
$('summary-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { updateState(await api.saveSummary(summaryTarget.chatId, $('summary-text').value, summaryTarget.id)); $('summary-dialog').close(); contextKey = ''; renderIntelligence(); }
  catch (error) { setText('summary-error', errorText(error)).hidden = false; }
});

const apiPhaseLabels = { waiting: 'Ожидание ответа', receiving: 'Проверяем целостность ответа', retry: 'Повтор после сбоя', done: 'Готово', error: 'Ошибка', cancelled: 'Остановлено', interrupted: 'Прервано перезапуском' };
function renderApiRequests() {
  const rows = (state.apiRequests ?? []).filter(item => item.chatId === state.activeChat);
  const list = $('api-list'); list.replaceChildren();
  for (const item of rows.slice(0, 60)) {
    const row = element('details', 'api-request api-' + item.phase); row.open = openApiRows.has(item.id);
    row.dataset.apiId = item.id;
    row.addEventListener('toggle', () => { if (row.open) openApiRows.add(item.id); else openApiRows.delete(item.id); });
    const title = `${apiPhaseLabels[item.phase] ?? item.phase} · попытка ${item.attempt ?? 1}/${item.maxAttempts ?? 3} · ${Math.round(item.elapsedMs / 1000)} с`;
    row.append(element('summary', '', title));
    row.append(element('p', '', item.reason ?? (item.kind === 'summary' ? 'Сжатие контекста' : 'Запрос модели')));
    for (const event of item.events ?? []) if (event.phase === 'retry') row.append(element('p', 'retry-note', `Попытка ${event.attempt}: ${event.reason} · автоматический повтор запроса`));
    row.append(element('p', 'muted', item.usage ? `API: вход ${item.usage.input ?? '—'} · выход ${item.usage.output ?? '—'} · всего ${item.usage.total} токенов` : `Длина входа: ${item.inputChars.toLocaleString()} символов · примерно ${Math.ceil(item.inputChars / 4).toLocaleString()} токенов (оценка). Фактический расход API не передан.`));
    list.append(row);
  }
  if (!rows.length) list.append(element('p', 'panel-note', 'Здесь появятся запросы, попытки восстановления и данные использования API.'));
}
api.onApiRequest(item => {
  if (!state) return; state.apiRequests ??= []; const index = state.apiRequests.findIndex(row => row.id === item.id);
  if (index === -1) state.apiRequests.unshift(item); else state.apiRequests[index] = item;
  renderIntelligence();
});
function renderIntelligence() {
  if (!state) return;
  for (const [mode, id] of [['problems', 'problems-panel'], ['context', 'context-panel'], ['api', 'api-panel']]) {
    $(id).hidden = workflowMode !== mode; $('drawer-' + mode + '-tab').classList.toggle('selected', workflowMode === mode);
  }
  const chat = activeChat(); for (const id of ['show-context', 'show-problems', 'show-api']) $(id).disabled = !chat;
  if (!chat) return;
  $('compress-context').disabled = compressing || Boolean(state.busy || state.workspaceMutation);
  $('edit-summary').disabled = compressing || Boolean(state.busy || state.workspaceMutation); $('cancel-compression').hidden = !compressing;
  const request = (state.apiRequests ?? []).find(item => item.chatId === chat.id);
  setText('show-api', request && !['done', 'error', 'cancelled', 'interrupted'].includes(request.phase) ? 'API · ' + (request.attempt ?? 1) : 'API');
  if (workflowMode === 'problems') renderProblems();
  if (workflowMode === 'context') { const key = contextStateKey(); if (key !== contextKey) { contextKey = key; void refreshContextDetails(); } else renderContextList(); }
  if (workflowMode === 'api') renderApiRequests();
}
for (const [id, mode] of [['show-problems', 'problems'], ['show-context', 'context'], ['show-api', 'api'], ['drawer-problems-tab', 'problems'], ['drawer-context-tab', 'context'], ['drawer-api-tab', 'api']]) $(id).addEventListener('click', () => openWorkflow(mode));
if (state) renderIntelligence();
setInterval(() => {
  if (workflowMode !== 'api' || !state) return;
  for (const item of state.apiRequests ?? []) if (['waiting', 'receiving', 'retry'].includes(item.phase)) {
    const row = [...$('api-list').querySelectorAll('[data-api-id]')].find(row => row.dataset.apiId === item.id);
    if (row) row.querySelector('summary').textContent = `${apiPhaseLabels[item.phase]} · попытка ${item.attempt ?? 1}/${item.maxAttempts ?? 3} · ${Math.round((Date.now() - item.startedAt) / 1000)} с`;
  }
}, 1000);
