'use strict';
let comparisonKey = '', comparisonLabel = 'Конфигурация репозитория', comparisonGeneration = 0;
function refreshComparison() {
  comparisonKey = '';
  if (workflowMode === 'commands' && activeChat()) renderWorkflow();
}
api.onRepositoryChanged(root => {
  if (state?.projects.find(p => p.id === activeChat()?.projectId)?.path === root) refreshComparison();
});
window.addEventListener('focus',refreshComparison);
function repositoryControls(chat) {
  const key = JSON.stringify([chat.id,state.profileSets[chat.projectId]]);
  if (comparisonKey !== key) {
    comparisonKey = key; comparisonLabel = 'Конфигурация репозитория';
    const generation = ++comparisonGeneration;
    api.compareProfiles(chat.id).then(({repo,local}) => {
      if (generation !== comparisonGeneration || state.activeChat !== chat.id) return;
      if (repo !== null && JSON.stringify(repo) !== JSON.stringify(local)) {
        comparisonLabel = 'Сравнить профили с репозиторием';
        if (workflowMode === 'commands') renderWorkflow();
      }
    }).catch(() => {});
  }
  const group = element('div','profile-controls');
  for (const [mode, label] of [['discover','Найти пакеты и команды'],['compare',comparisonLabel]]) {
    const button = workflowButton(label, () => openRepositoryProfiles(chat, mode));
    button.dataset.repository = mode;
    group.append(button);
  }
  return group;
}

async function openRepositoryProfiles(chat, mode) {
  const dialog = $('repo-profiles-dialog'), list = $('repo-profiles-list'), actions = $('repo-profiles-actions');
  const discovery = mode === 'discover';
  setText('repo-profiles-title', discovery ? 'Найти пакеты и команды' : 'Конфигурация репозитория');
  const root = state.projects.find(p => p.id === chat.projectId).path;
  setText('repo-profiles-location', root + (discovery ? '' : ' · .alicecode/project.json'));
  list.textContent = 'Читаем настройки…'; actions.replaceChildren(); $('repo-profiles-error').hidden = true;
  if (!dialog.open) dialog.showModal();
  const action = (label, fn, id) => {
    const button = workflowButton(label, async () => {
      const buttons = [...actions.querySelectorAll('button')];
      buttons.forEach(b => b.disabled = true);
      try { updateState(await fn()); dialog.close(); }
      catch (error) { setText('repo-profiles-error',errorText(error)).hidden = false; }
      finally { buttons.forEach(b => b.disabled = false); }
    });
    button.id = id; actions.append(button);
    return button;
  };
  try {
    const preview = discovery ? await api.discoverProfiles(chat.id) : await api.compareProfiles(chat.id);
    if (!dialog.open || state.activeChat !== chat.id) return;
    list.replaceChildren();
    if (discovery) {
      const chosen = new Set();
      for (const p of preview.profiles) {
        const row = element('article','repo-profile'), label = element('label','check-label'), checkbox = element('input');
        checkbox.type = 'checkbox'; checkbox.checked = Boolean(p.sequence.length);
        if (checkbox.checked) chosen.add(p.id);
        checkbox.onchange = () => { if (checkbox.checked) chosen.add(p.id); else chosen.delete(p.id); apply.disabled = !chosen.size; };
        label.append(checkbox,document.createTextNode(p.name)); row.append(label);
        row.append(element('small','muted',[p.directory || '.',p.config].filter(Boolean).join(' · ')));
        row.append(element('code','',Object.values(p.commands).join(' · ') || 'Команды не найдены'));
        if (p.scope.length) row.append(element('small','muted','Пути проверки · ' + p.scope.join(', ')));
        for (const reason of Object.values(p.links ?? {})) row.append(element('small','muted',reason));
        if (preview.local.some(old=>old.id === p.id)) row.append(element('small','muted','Обновит локальный профиль'));
        list.append(row);
      }
      if (!preview.profiles.length) list.textContent = 'В package.json не найдены пакеты или команды.';
      const apply = action('Применить выбранные',()=>api.adoptProfiles(chat.id,[...chosen],preview.token),'repo-adopt');
      apply.disabled = !chosen.size;
    } else {
      const { local, repo, token } = preview;
      const keys = new Set([...local, ...(repo ?? [])].map(p => p.id));
      let count = 0;
      for (const key of keys) {
        const here = local.find(p=>p.id===key), there = repo?.find(p=>p.id===key);
        if (JSON.stringify(here) === JSON.stringify(there)) continue;
        count++;
        const row = element('details','repo-profile'); row.open = true;
        row.append(element('summary','',(here ?? there).name));
        for (const [title, value] of [['В приложении',here],['В репозитории',there]]) {
          row.append(element('strong','',title),element('pre','context-text',value ? JSON.stringify(value,null,2) : 'Профиль отсутствует'));
        }
        list.append(row);
      }
      if (!count) list.textContent = repo ? 'Профили и команды совпадают.' : 'Сначала добавьте профили проекта.';
      if (repo && count) action('Применить версию репозитория',()=>api.syncProfiles(chat.id,'load',token),'repo-load');
      if (count) action('Сохранить в репозитории',()=>api.syncProfiles(chat.id,'save',token),'repo-save');
    }
  } catch (error) { list.replaceChildren(); setText('repo-profiles-error',errorText(error)).hidden = false; }
}
if (state) renderWorkflow();
