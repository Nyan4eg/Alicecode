import { mkdtemp, mkdir, realpath, rm, readdir, lstat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { gitIn, gitPrefix } from './workspace.mjs';
import { repositoryRoot } from './git.mjs';
import { finishReview } from './review.mjs';
import { editableFile, editDiff, fingerprint, mergeText, removeChecked, textForDisk, validateText, writeChecked } from './editing.mjs';

export async function createTaskWorkspace(source, home, id, branch) {
  if (!/^[a-f0-9-]{36}$/.test(id) || typeof branch !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_./-]{0,100}$/.test(branch)) throw new Error('Введите допустимое имя ветки.');
  const repo = await repositoryRoot(source);
  await gitIn(repo, ['check-ref-format', '--branch', branch]);
  const prefix = await gitPrefix(source);
  if (await gitIn(repo, ['ls-files', '--unmerged', '-z'])) throw new Error('Разрешите конфликты Git перед созданием рабочей папки.');
  await mkdir(home, { recursive: true });
  const parent = await realpath(home);
  const directory = join(parent, id);
  const scratch = await mkdtemp(join(tmpdir(), 'alicecode-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index'), GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Alicecode', GIT_AUTHOR_EMAIL: 'snapshot@alicecode.local', GIT_COMMITTER_NAME: 'Alicecode', GIT_COMMITTER_EMAIL: 'snapshot@alicecode.local' };
  try {
    const head = await gitIn(repo, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim(), () => null);
    const sourceBranch = await gitIn(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => value.trim(), () => '(detached)');
    await gitIn(repo, ['read-tree', ...(head ? [head] : ['--empty'])], { env });
    // This alternate index includes on-disk edits in the selected project, while leaving the user's index untouched.
    await gitIn(repo, ['add', '-A', '--', prefix || '.'], { env, timeout: 120000 });
    const tree = (await gitIn(repo, ['write-tree'], { env })).trim();
    const base = (await gitIn(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'Alicecode: initial task snapshot'], { env })).trim();
    await gitIn(repo, ['worktree', 'add', '-b', branch, directory, base], { timeout: 120000 });
    const root = await realpath(resolve(directory, prefix || '.'));
    if (relative(directory, root).startsWith('..')) throw new Error('Рабочая папка находится вне задачи.');
    return { root, directory, originalRoot: await realpath(source), sourceRepo: repo, prefix, branch, base, head, sourceBranch };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function baseText(workspace, path) {
  const key = workspace.prefix + path;
  const entry = await gitIn(workspace.directory, ['ls-tree', '-z', workspace.base, '--', key]);
  if (!entry) return null;
  const blob = /^100(?:644|755) blob ([a-f0-9]+)\t/.exec(entry)?.[1];
  if (!blob || Number(await gitIn(workspace.directory, ['cat-file', '-s', blob])) > 512000) throw new Error('Перенос поддерживает обычные текстовые файлы до 512 КБ.');
  const bytes = await gitIn(workspace.directory, ['cat-file', 'blob', blob], { encoding: 'buffer', maxBuffer: 512001 });
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Двоичный файл требует ручного переноса.');
  return text;
}

export async function transferPreview(workspace) {
  if (!workspace?.base) throw new Error('У чата нет отдельной рабочей папки.');
  if (await realpath(workspace.directory) !== workspace.directory || await realpath(workspace.originalRoot) !== workspace.originalRoot) throw new Error('Расположение рабочей папки изменилось.');
  const sourceBranch = await gitIn(workspace.sourceRepo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => value.trim(), () => '(detached)');
  if (workspace.sourceBranch && sourceBranch !== workspace.sourceBranch) throw new Error('В исходном проекте выбрана другая ветка. Вернитесь в ' + workspace.sourceBranch + ' перед переносом.');
  const review = await finishReview(workspace.root, { head: workspace.base, dirty: new Set(), files: new Map() });
  if (review.state !== 'ready') throw new Error('Сравнение задачи неполное. Перенос через интерфейс недоступен; проверьте файлы вручную.');
  const files = [];
  for (const change of review.files) {
    const item = { path: change.path };
    files.push(item);
    try {
      const base = await baseText(workspace, change.path);
      const desired = await editableFile(workspace.root, change.path, true);
      const current = await editableFile(workspace.originalRoot, change.path, true);
      Object.assign(item, { current, desiredStamp: desired.stamp, base, desired: desired.text,
        resolvable: current.text !== null && desired.text !== null });
      if (base === null) {
        if (current.text !== null && current.text !== desired.text) throw new Error('Файл с таким именем уже появился в исходном проекте.');
        item.text = desired.text;
      } else if (desired.text === null) {
        if (current.text !== null && current.text.replace(/\r\n/g, '\n') !== base.replace(/\r\n/g, '\n')) throw new Error('Алиса удалила файл, в котором появились ваши изменения.');
        item.text = null;
      } else {
        if (current.text === null) throw new Error('Файл удалён в исходном проекте.');
        const result = await mergeText(current.text.replace(/\r\n/g, '\n'), base.replace(/\r\n/g, '\n'), desired.text.replace(/\r\n/g, '\n'));
        if (result.conflict) { item.conflict = result.conflict; continue; }
        item.text = textForDisk(current.text, result.text);
      }
      item.patch = await editDiff(current.text, item.text);
    } catch (error) { item.conflict = error.message; }
  }
  const token = fingerprint(JSON.stringify(files.map(file => [file.path, file.current?.stamp, file.desiredStamp, file.text, file.conflict])));
  return { token, files, conflict: files.some(file => file.conflict) };
}

export async function applyTransfer(workspace, token, selection = null, resolutions = {}) {
  const preview = await transferPreview(workspace);
  if (preview.token !== token) throw new Error('Файлы изменились или найден конфликт. Проверьте перенос заново.');
  return writeTransfer(workspace, await resolveTransfer(preview, selection, resolutions));
}

export async function resolveTransfer(preview, selection, resolutions = {}) {
  if (selection !== null && !Array.isArray(selection)) throw new Error('Выберите файлы из текущего сравнения.');
  const selected = selection === null ? preview.files : preview.files.filter(file => selection.includes(file.path));
  if (selection && (!selection.length || new Set(selection).size !== selection.length || selected.length !== selection.length)) throw new Error('Выберите файлы из текущего сравнения.');
  const result = [];
  for (const original of selected) {
    const file = { ...original };
    if (file.conflict) {
      const resolution = resolutions[file.path];
      if (!file.resolvable || typeof resolution !== 'string') throw new Error('Сначала разрешите конфликт: ' + file.path);
      validateText(resolution);
      if (/^(<<<<<<< |\|\|\|\|\|\|\| |=======$|>>>>>>> )/m.test(resolution)) throw new Error('В результате остались маркеры конфликта: ' + file.path);
      file.text = textForDisk(file.current.text, resolution);
    }
    if (file.text !== file.current.text) {
      if (file.conflict) file.patch = await editDiff(file.current.text, file.text);
      result.push(file);
    }
  }
  return result;
}

export async function writeTransfer(workspace, selected) {
  const applied = [];
  try {
    for (const file of selected) {
      if (file.text === null) await removeChecked(workspace.originalRoot, file.current);
      else await writeChecked(workspace.originalRoot, file.current, file.text);
      applied.push(file);
    }
  } catch (error) {
    const retained = [];
    for (const file of applied.reverse()) {
      try {
        const now = await editableFile(workspace.originalRoot, file.path, true);
        if (now.text !== file.text) { retained.push(file.path); continue; }
        if (file.current.text === null) await removeChecked(workspace.originalRoot, now);
        else await writeChecked(workspace.originalRoot, now, file.current.text);
      } catch { retained.push(file.path); }
    }
    throw new Error(error.message + (retained.length ? ' Частично перенесены: ' + retained.join(', ') : ' Перенос отменён.'));
  }
  return applied.map(file => file.path);
}

export async function taskWorkspaceDetails(workspace, home) {
  const parent = await realpath(home);
  if (workspace.state === 'removed') return { ...workspace, exists: false, removable: false };
  const folder = await realpath(workspace.directory).catch(() => null);
  if (!folder || dirnameOf(folder) !== parent || !/^[a-f0-9-]{36}$/.test(folder.slice(parent.length + 1))) return { ...workspace, exists: Boolean(folder), removable: false, note: 'Папка задачи отсутствует или находится вне профиля.' };
  const branch = (await gitIn(folder, ['branch', '--show-current'])).trim();
  if (branch !== workspace.branch) return { ...workspace, exists: true, removable: false, note: 'В рабочей папке выбрана другая ветка.' };
  let bytes = 0, count = 0, incomplete = false;
  const scan = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 30000) { incomplete = true; return; }
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await scan(file); else bytes += (await lstat(file)).size;
      if (incomplete) return;
    }
  };
  await scan(folder);
  let pending = true, note;
  try {
    const preview = await transferPreview(workspace);
    pending = preview.files.some(file => {
      const transferred = workspace.transferred?.[file.path];
      const confirmed = Object.hasOwn(workspace.transferred ?? {}, file.path) && transferred === file.desiredStamp;
      return !confirmed && (file.conflict || file.text !== file.current?.text);
    });
    if (pending) note = 'Есть неперенесённые изменения. Сначала перенесите результат.';
  } catch (error) { note = error.message; }
  return { ...workspace, exists: true, bytes, incomplete, removable: !pending, note };
}
function dirnameOf(path) { return resolve(path, '..'); }
export async function removeTaskWorkspace(workspace, home) {
  const details = await taskWorkspaceDetails(workspace, home);
  if (!details.removable) throw new Error(details.note ?? 'Рабочую папку нельзя удалить.');
  // Git owns removal; only the validated task directory under this profile may be removed.
  await gitIn(workspace.sourceRepo, ['worktree', 'remove', '--force', workspace.directory], { timeout: 120000 });
  return { ...workspace, state: 'removed', removedAt: Date.now() };
}
