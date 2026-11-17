import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { gitIn, gitPrefix } from './workspace.mjs';
import { repositoryRoot } from './git.mjs';
import { finishReview } from './review.mjs';
import { editableFile, editDiff, fingerprint, mergeText, removeChecked, textForDisk, writeChecked } from './editing.mjs';

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
      Object.assign(item, { current, desiredStamp: desired.stamp });
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

export async function applyTransfer(workspace, token) {
  const preview = await transferPreview(workspace);
  if (preview.token !== token || preview.conflict) throw new Error('Файлы изменились или найден конфликт. Проверьте перенос заново.');
  const applied = [];
  try {
    for (const file of preview.files) {
      if (file.text === file.current.text) continue;
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
