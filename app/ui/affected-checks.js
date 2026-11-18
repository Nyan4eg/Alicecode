'use strict';
const affectedPanel = element('section', 'affected-checks');
affectedPanel.setAttribute('aria-label', 'Проверки пакетов');
let affectedKey, affectedChat, affectedData, affectedTimer, affectedRequest = 0;
let manualProfiles = new Map();
const checkingChats = new Set();
const checkLabels = { missing: 'Ещё не проверен', completed: 'Успешно', failed: 'Ошибка', stale: 'Нужно повторить',
  interrupted: 'Прервано', in_progress: 'Выполняется', unknown: 'Версия не подтверждена' };

function renderAffectedChecks(host, chat) {
  host.append(affectedPanel);
  const profiles = state.profileSets[chat.projectId];
  const key = JSON.stringify([chat.id, currentRoot(), profiles]);
  if (affectedKey !== key) {
    affectedKey = key; affectedChat = chat.id; affectedData = null; manualProfiles = new Map();
    affectedPanel.textContent = 'Определяем затронутые пакеты…';
    scheduleChecks(0);
  } else if (affectedData) drawChecks();
}

function scheduleChecks(delay = 150) {
  clearTimeout(affectedTimer);
  const request = ++affectedRequest;
  if (workflowMode !== 'task' || !activeChat()) { affectedKey = null; return; }
  const id = state.activeChat;
  affectedTimer = setTimeout(async () => {
    try {
      const data = await api.affectedChecks(id);
      if (request !== affectedRequest || state.activeChat !== id) return;
      affectedData = data; drawChecks();
    } catch (error) {
      if (request === affectedRequest && state.activeChat === id) {
        affectedData = null; affectedPanel.replaceChildren(element('span','error',errorText(error)),workflowButton('Обновить', () => scheduleChecks(0)));
      }
    }
  }, delay);
}

function drawChecks() {
  const chat = activeChat();
  if (!chat || chat.id !== affectedChat || !affectedData) return;
  const { rows, uncovered, git } = affectedData;
  const busy = checkingChats.has(chat.id) || state.commandRuns.some(run => run.chatId === chat.id && run.steps && runIsActive(run));
  const selected = row => row.configured && (manualProfiles.get(row.id) ?? Boolean(row.reasons.length));
  const pending = rows.filter(row => selected(row) && row.status !== 'completed');
  const launch = workflowButton(busy ? 'Проверяем…' : 'Проверить затронутые' + (pending.length ? ' · ' + pending.length : ''), async () => {
    checkingChats.add(chat.id); drawChecks();
    try { await api.runAffected(chat.id, rows.filter(selected).map(row => row.id)); }
    catch (error) { toast(error); }
    finally { checkingChats.delete(chat.id); scheduleChecks(0); }
  });
  launch.id = 'run-affected'; launch.disabled = busy || !pending.length || Boolean(chat.archivedAt);
  const head = element('div','affected-heading'); head.append(element('strong','','Проверки пакетов'),launch);
  affectedPanel.replaceChildren(head);
  if (!git) affectedPanel.append(element('small','muted','Чтобы проверить папку вне Git, выберите профили вручную.'));
  if (uncovered.length) affectedPanel.append(element('small','error','Без настроенной проверки · ' + uncovered.join(', ')));
  const manual = element('details');
  manual.append(element('summary','muted','Выбрать другие профили'));
  for (const row of rows) {
    const line = element('div','affected-row');
    line.dataset.profile = row.id; line.dataset.status = row.status;
    const label = element('label','check-label'), check = element('input');
    check.type = 'checkbox'; check.checked = selected(row); check.disabled = busy || !row.configured;
    check.onchange = () => { manualProfiles.set(row.id,check.checked); drawChecks(); };
    label.append(check,document.createTextNode(row.name)); line.append(label);
    const status = element('span', 'run-state run-' + row.status, row.configured ? checkLabels[row.status] : 'Нет шагов проверки');
    line.append(status);
    if (row.reasons.length) {
      const why = element('small','affected-reason',row.reasons[0] + (row.reasons.length > 1 ? ' +' + (row.reasons.length - 1) : ''));
      const explanation = path => {
        const scope = Object.keys(row.links ?? {}).filter(key => key === path || path.startsWith(key + '/')).sort((a,b) => b.length-a.length)[0];
        return scope ? path + ' → ' + row.links[scope] : path;
      };
      why.textContent = explanation(row.reasons[0]) + (row.reasons.length > 1 ? ' +' + (row.reasons.length - 1) : '');
      why.title = row.reasons.map(explanation).join('\n'); line.append(why);
    }
    if (row.problem && row.status === 'failed') {
      const issue = row.problem;
      const location = issue.path ? workflowButton(issue.text, () => { showInspector(true); openEditor(issue.path, issue.line); }, 'quiet affected-error') : element('span','error',issue.text);
      location.title = issue.text; line.append(location);
      if (row.failure) {
        const repair = workflowButton('Исправить с Алисой в ' + row.name, async () => {
          repair.disabled = true;
          try { workflowTaskId = null; await api.repairCheck(chat.id,row.failure); }
          catch (error) { toast(error); } finally { scheduleChecks(0); }
        });
        repair.dataset.repair = row.id;
        repair.disabled = busy || Boolean(state.busy || chat.archivedAt) || chat.mode !== 'code'; line.append(repair);
      }
    }
    if (row.runId) line.append(workflowButton('Журнал', () => { selectedCommandId = row.failure ?? row.runId; openWorkflow('commands'); }));
    if (row.reasons.length || manualProfiles.get(row.id) || row.runId) affectedPanel.append(line);
    else manual.append(line);
  }
  if (manual.children.length > 1) affectedPanel.append(manual);
  if (!rows.length) affectedPanel.append(element('small','muted','Настройте шаги проверки в профиле команд.'));
}
api.onChecksChanged(root => { if (state && root === currentRoot()) scheduleChecks(); });
api.onCommand(run => { if (run.chatId === state?.activeChat && run.steps) scheduleChecks(); });
window.addEventListener('focus', () => { if (state) scheduleChecks(); });
if (state) renderWorkflow();
