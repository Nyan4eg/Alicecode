import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { gitIn, projectEntry } from './workspace.mjs';
import { testInvocation } from './replay.mjs';

export function checkKind(command, profile, key) {
  if (key === 'test' || key === 'build') return key;
  if (!command) return null;
  if (command === profile?.commands?.test || testInvocation(command)) return 'test';
  if (command === profile?.commands?.build || /^(?:npm run build|tsc --noEmit)$/.test(command)) return 'build';
  return null;
}

// Hash saved working files, including untracked sources. Staging alone does not change the version.
export async function codeVersion(root) {
  try {
    const listing = await gitIn(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']);
    const paths = [...new Set(listing.split('\0').filter(Boolean))].sort();
    if (paths.length > 5000) return null;
    const digest = createHash('sha256');
    let total = 0;
    for (const path of paths) {
      let file;
      try { file = await projectEntry(root, path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const info = await stat(file);
      total += info.size;
      if (!info.isFile() || total > 64 * 1024 * 1024 || info.size > 8 * 1024 * 1024) return null;
      const bytes = await readFile(file);
      digest.update(path).update('\0').update(createHash('sha256').update(bytes).digest());
    }
    return digest.digest('hex');
  } catch { return null; }
}

export function diffRange(patch, first, last) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last-first >= 40) throw Error('Выберите до 40 строк одного фрагмента.');
  const lines = patch.split(/\r?\n/);
  if (last >= lines.length) throw Error('Строка отсутствует в сохранённом diff.');
  let oldLine, newLine;
  const excerpt = [];
  let start, end, side;
  for (let i = 0; i <= last; i++) {
    const line = lines[i] ?? '';
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); }
    const kind = line[0];
    if (i >= first) {
      if (oldLine === undefined || !['+', '-', ' '].includes(kind)) throw Error('Выберите строки кода внутри одного фрагмента.');
      const currentSide = kind === '-' ? 'old' : 'new';
      if (side && currentSide !== side) throw Error('Выберите строки одной версии файла.');
      side = currentSide;
      end = side === 'old' ? oldLine : newLine;
      start ??= end;
      excerpt.push(line.slice(1));
    }
    if (kind === '-' || kind === ' ') oldLine++;
    if (kind === '+' || kind === ' ') newLine++;
  }
  const snippet = excerpt.join('\n');
  if (snippet.length > 4000) throw Error('Выберите более короткий фрагмент.');
  return { start, end, side, snippet };
}
