'use strict';
let noteTarget;
const versions = new Map();
const refreshTimers = new Map();
const addNoteButton = $('add-review-note');
addNoteButton.addEventListener('mousedown', event => event.preventDefault());
addNoteButton.addEventListener('click', () => {
  if (preview?.mode !== 'review') return;
  const selection = window.getSelection();
  const rows = [...$('preview-content').querySelectorAll('[data-patch-index]')];
  let selected = rows.filter(row => selection.rangeCount && selection.containsNode(row, true));
  selected = selected.filter(row => /^[ +\-]/.test(row.children[1].textContent));
  if (!selected.length) return toast('Выделите строки кода в сохранённом diff.');
  const first = Number(selected[0].dataset.patchIndex), last = Number(selected.at(-1).dataset.patchIndex);
  const removed = selected[0].classList.contains('diff-remove');
  if (last - first >= 40 || selected.length !== last-first+1 || selected.some(row => row.classList.contains('diff-remove') !== removed)) {
    return toast('Выберите до 40 строк одной версии файла в одном фрагменте.');
  }
  noteTarget = { chat: state.activeChat, origin: preview.messageId, path: preview.path, first, last };
  setText('note-location', preview.path);
  setText('note-excerpt', selected.map(row => row.children[1].textContent).join('\n'));
  $('note-body').value = '';
  $('review-note-dialog').showModal();
  $('note-body').focus();
});
$('review-note-form').addEventListener('submit', async event => {
  event.preventDefault();
  const { chat, origin, path, first, last } = noteTarget;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    updateState(await api.addReviewNote(chat, origin, path, first, last, $('note-body').value));
    $('review-note-dialog').close();
    workflowTaskId = origin;
    openWorkflow('task');
  } catch (error) { toast(error); }
  finally { if (submit) submit.disabled = false; }
});

async function visitNote(note) {
  const chat = state.activeChat, buffer = editorGroup()?.get(note.path);
  try {
    const text = buffer?.dirty ? buffer.text : (await api.readEditor(chat, note.path)).text;
    if (state.activeChat !== chat) return;
    const lines = text.replace(/\r\n/g, '\n').split('\n'), excerpt = note.anchor.snippet.split('\n');
    const matches = lines.flatMap((value, i) => value === excerpt[0] && excerpt.every((line, j) => lines[i+j] === line) ? [i+1] : []);
    if (note.anchor.side === 'new' && matches.length === 1) return openEditor(note.path, matches[0]);
  } catch {}
  if (state.activeChat !== chat) return;
  toast('Точное место в текущем файле не найдено. Исходный фрагмент сохранён в замечании.');
}

function isCheck(run) {
  return run.check || run.tests || ['Тесты', 'Сборка'].includes(run.label) || /^(node --test|npm (test|run build))(\s|$)/.test(run.command);
}
function loadVersion(root) {
  const original = state.projects.find(p => p.id === activeChat()?.projectId)?.path;
  if (root !== currentRoot() && root !== original) return;
  const entry = {};
  versions.set(root, entry);
  api.checkVersion(state.activeChat, root === original).then(value => {
    if (versions.get(root) !== entry) return;
    entry.value = value; renderWorkflow();
  }).catch(() => { if (versions.get(root) === entry) { entry.value = null; renderWorkflow(); } });
}
function invalidateVersion(root) {
  if (!versions.has(root)) return;
  clearTimeout(refreshTimers.get(root));
  refreshTimers.set(root, setTimeout(() => {
    refreshTimers.delete(root);
    versions.delete(root);
    renderWorkflow();
  }, 200));
}
api.onChecksChanged(invalidateVersion);
window.addEventListener('focus', () => { for (const root of versions.keys()) invalidateVersion(root); });
function versionBadge(run) {
  let label = 'Версия кода не подтверждена', stale = false;
  if (run.version) {
    if (!versions.has(run.root)) loadVersion(run.root);
    const entry = versions.get(run.root);
    if (entry && !('value' in entry)) label = 'Сверяем файлы…';
    if (entry?.value) {
      stale = entry.value !== run.version;
      label = stale ? 'Код изменился после проверки' : 'Проверено на текущем коде';
    }
  }
  const badge = element('span', stale ? 'check-version stale' : 'check-version', label);
  badge.title = run.cwd;
  return badge;
}
function renderReviewNotes(host, message, runs) {
  const notes = state.reviewNotes ?? [];
  for (const note of notes) {
    const row = element('details', 'review-note');
    const heading = element('summary', '', (note.resolved ? 'Решено' : note.reply ? 'На проверке' : 'Черновик') + ' · ' + note.path + ':' + note.anchor.start + ' · ' + note.body);
    row.append(heading, element('pre', 'context-text', note.anchor.snippet),
      workflowButton('К строке', () => visitNote(note)),
      workflowButton(note.resolved ? 'Открыть снова' : 'Отметить решённым', async () => {
        try { updateState(await api.resolveReviewNote(state.activeChat, note.id, !note.resolved)); } catch (error) { toast(error); }
      }));
    const linked = state.messages.find(message => message.id === note.reply);
    if (linked?.review?.files.some(file => file.path === note.path)) {
      row.append(workflowButton('Доработка файла', () => openReview(linked, note.path)));
    }
    host.append(row);
  }
  if (notes.some(note => !note.reply && !note.resolved)) {
    const button = workflowButton('Отправить замечания Алисе', async () => {
      button.disabled = true;
      workflowTaskId = null;
      try { await api.sendReviewNotes(state.activeChat); } catch (error) { toast(error); } finally { button.disabled = false; }
    });
    button.disabled = Boolean(state.busy) || activeChat()?.mode !== 'code';
    host.append(button);
  }
  const replies = new Set(notes.map(note => note.reply).filter(Boolean));
  for (const reply of state.messages.filter(item => replies.has(item.id) && item.review)) {
    const button = workflowButton('Изменения после замечаний · ' + reply.review.files.length, () => openReview(reply));
    button.disabled = !reply.review.files.length;
    host.append(button);
  }
  const seen = new Set();
  for (const run of runs.filter(run => isCheck(run) && !runIsActive(run))) {
    const key = JSON.stringify([run.root, run.command]);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = element('div', 'review-check');
    row.append(element('strong', '', run.command + ' · ' + (run.exitCode === 0 ? 'Успешно' : runLabels[run.status])),
      element('small', 'muted', run.cwd), versionBadge(run),
      workflowButton('Повторить', async () => {
        try { mergeCommand(await api.repeatCommand(run.id)); } catch (error) { toast(error); }
      }));
    host.append(row);
  }
}
if (state) renderWorkflow();
