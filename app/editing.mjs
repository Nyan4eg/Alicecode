import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, link, unlink, mkdtemp, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { diffLines } from 'diff';
import { projectPath } from './activity.mjs';
import { gitIn, projectEntry } from './workspace.mjs';

const limit = 512_000;
const unavailable = 'Выберите текстовый файл UTF-8 в рабочей папке проекта.';
export const fingerprint = text => createHash('sha256').update(text).digest('hex');

export function validateText(text) {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text) > limit) {
    throw new Error('Поддерживаются текстовые файлы UTF-8 до 512 КБ.');
  }
}

export function editorText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function textForDisk(before, draft) {
  validateText(draft);
  const bom = before.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = before.slice(bom.length);
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized === draft) return before;
  const ending = source.includes('\r\n') && !/(?<!\r)\n/.test(source) ? '\r\n' : '\n';
  if (!source.includes('\r\n') || ending === '\r\n') return bom + draft.replace(/\n/g, ending);
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset = 0;
  const merged = diffLines(normalized, draft, { timeout: 500 });
  if (!merged) throw new Error('Слишком много отличий для безопасного сохранения файла.');
  return bom + merged.map(part => {
    if (part.added) return part.value;
    const from = offset;
    offset += part.count;
    return part.removed ? '' : lines.slice(from, offset).join('');
  }).join('');
}

export function agentTextForDisk(before, content) {
  if (before === null) return content;
  const draft = editorText(content);
  const ending = draft && before.endsWith('\n') && !draft.endsWith('\n') ? '\n' : '';
  return textForDisk(before, draft + ending);
}

async function fileLocation(root, target) {
  const base = await realpath(root);
  if (process.platform === 'win32' && typeof target === 'string') {
    target = target.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '').replace(/^\\\\\?\\UNC\\/i, '\\\\');
  }
  const path = projectPath(base, target);
  if (!path || path.split('/').some(part => /[:*?"<>|]/.test(part) || /[. ]$/.test(part)
    || ['.git', 'node_modules', '.venv', '__pycache__'].includes(part.toLowerCase())
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(unavailable);
  const absolute = resolve(base, path);
  let ancestor = dirname(absolute);
  // Check the nearest existing parent first, even for files in new directories.
  while (ancestor !== base) {
    try {
      const actual = await projectEntry(base, ancestor);
      if (relative(actual, ancestor) || !(await lstat(ancestor)).isDirectory()) throw new Error(unavailable);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  return { path, absolute };
}

export async function editableFile(root, target, allowMissing = false) {
  const location = await fileLocation(root, target);
  let handle;
  try {
    const existing = await lstat(location.absolute);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(unavailable);
    handle = await open(location.absolute, 'r');
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size > limit) throw new Error(unavailable);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(entry.size + 1), 0, entry.size + 1, 0);
    if (bytesRead !== entry.size || (await handle.stat()).mtimeMs !== entry.mtimeMs) {
      throw new Error('Файл изменился во время чтения. Откройте его заново.');
    }
    const bytes = buffer.subarray(0, bytesRead);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error(unavailable); }
    validateText(text);
    return { ...location, text, stamp: fingerprint(bytes), mode: entry.mode };
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { ...location, text: null, stamp: null };
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeChecked(root, previous, text, check = () => {}) {
  validateText(text);
  const current = await editableFile(root, previous.path, true);
  if (current.stamp !== previous.stamp || current.absolute !== previous.absolute) {
    throw new Error('Файл изменился. Проверьте изменения заново.');
  }
  if (text === current.text) return current;
  check();
  await mkdir(dirname(current.absolute), { recursive: true });
  const temp = join(dirname(current.absolute), '.alicecode-' + randomUUID() + '.tmp');
  const file = await open(temp, 'wx', current.mode == null ? 0o666 : current.mode & 0o777);
  try {
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    const latest = await editableFile(root, previous.path, true);
    if (latest.stamp !== previous.stamp || latest.absolute !== previous.absolute) {
      throw new Error('Файл изменился. Проверьте изменения заново.');
    }
    check();
    if (current.stamp === null) await link(temp, current.absolute);
    else await rename(temp, current.absolute);
    return { ...current, text, stamp: fingerprint(text) };
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function temporaryTexts(items, operation) {
  const dir = await mkdtemp(join(tmpdir(), 'alicecode-edit-'));
  const paths = Object.keys(items).map(name => join(dir, name));
  try {
    await Promise.all(paths.map((path, index) => writeFile(path, Object.values(items)[index], 'utf8')));
    return await operation(dir, paths);
  } finally {
    await Promise.all(paths.map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    await rmdir(dir);
  }
}

export function editDiff(before, after) {
  if (before === after) return '';
  return temporaryTexts({ 'before.txt': before ?? '', 'after.txt': after ?? '' }, async (dir, paths) => {
    const output = await gitIn(dir, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
      '--', ...paths], { maxBuffer: 4_000_000 }).catch(error => {
      if (error.code === 1) return error.stdout;
      throw error;
    });
    const start = output.indexOf('\n@@ ');
    return start === -1 ? '' : output.slice(start + 1);
  });
}

export async function inverseText(current, before, after) {
  if (current === after) return { text: before };
  if (current === before) return { text: current };
  return temporaryTexts({ 'current.txt': current, 'after.txt': after, 'before.txt': before }, async (dir, paths) => {
    const args = ['merge-file', '-p', '--diff3', '-L', 'Текущий файл', '-L', 'После правки Алисы',
      '-L', 'До правки Алисы', '--', ...paths];
    return gitIn(dir, args, { maxBuffer: 4_000_000 }).then(text => ({ text }), error => {
      if (Number.isInteger(error.code) && error.code >= 1 && error.code <= 127) return { conflict: error.stdout };
      throw error;
    });
  });
}

export async function planRollback(root, path, edits) {
  if (!edits.length) throw new Error('Сохранённая правка для отката не найдена.');
  const file = await editableFile(root, path, true);
  const token = fingerprint(JSON.stringify([file.stamp, ...edits.map(edit => edit.id)]));
  if (file.text === null) return { conflict: 'Файл удалён или перемещён. Откройте исходную папку проекта.', token };
  let text = file.text;
  for (const edit of edits) {
    const result = await inverseText(text, edit.beforeText, edit.afterText);
    if ('conflict' in result) return { conflict: result.conflict, token };
    text = result.text;
  }
  return { file, token, text, patch: await editDiff(file.text, text) };
}

export function agentEdit(tool, file) {
  const input = tool.rawInput;
  if (!input) return;
  if (input.variant === 'Write' && typeof input.content === 'string') return input.content;
  if (input.variant !== 'SearchReplace' || !input.old_string || typeof input.new_string !== 'string' || file.text === null) return;
  const found = file.text.split(input.old_string);
  if (found.length === 2 || (found.length > 2 && input.replace_all === true)) return found.join(input.new_string);
}
