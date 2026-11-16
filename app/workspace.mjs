import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { projectPath } from './activity.mjs';

const exec = promisify(execFile);
const omitted = new Set(['.git', 'node_modules', '.venv', '__pycache__']);

export async function createProject(parent, value) {
  const title = value.trim();
  if (!title || title.length > 80 || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(title)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) {
    throw new Error('Введите допустимое имя папки.');
  }
  await mkdir(parent, { recursive: true });
  const path = join(await realpath(parent), title);
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Такая папка уже есть. Откройте её или выберите другое имя.');
    throw error;
  }
  await exec('git', ['init', '-q'], { cwd: path, windowsHide: true, timeout: 10_000 });
  return { title, path };
}

const visiblePath = path => path && !path.split('/').some(part => omitted.has(part.toLowerCase()));

// Resolve junctions and links before using a path selected in the explorer.
export async function projectEntry(root, target, allowRoot = false) {
  const base = await realpath(root);
  if (allowRoot && target === '') return base;
  const key = projectPath(base, target);
  if (!visiblePath(key)) throw new Error('Путь находится вне доступной части проекта.');
  const path = await realpath(resolve(base, key));
  if (!visiblePath(projectPath(base, path))) throw new Error('Путь находится вне доступной части проекта.');
  return path;
}

export async function readProjectFile(root, target) {
  const path = await projectEntry(root, target);
  const entry = await stat(path);
  if (!entry.isFile()) throw new Error('Выберите файл.');
  if (entry.size > 512_000) throw new Error('Файл слишком большой для просмотра.');
  const bytes = await readFile(path);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Файл не является текстом UTF-8.'); }
  if (content.includes('\0')) throw new Error('Двоичный файл.');
  return content;
}

export function gitIn(root, args, options = {}) {
  const { input, ...settings } = options;
  const task = exec('git', ['--literal-pathspecs', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000, ...settings,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (input != null) {
    task.child.stdin.on('error', () => {});
    task.child.stdin.end(input);
  }
  return task.then(result => result.stdout);
}

export function gitPrefix(root) {
  return gitIn(root, ['rev-parse', '--show-prefix']).then(value => value.replace(/\r?\n$/, ''), () => null);
}

const splitPaths = value => value.split('\0').filter(Boolean);

async function gitFiles(root) {
  if (await gitPrefix(root) === null) return null;
  return [...new Set(splitPaths(await gitIn(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
    { maxBuffer: 32_000_000 })))].filter(visiblePath);
}

async function directoryEntries(root, target) {
  const path = await projectEntry(root, target, true);
  const children = await readdir(path, { withFileTypes: true });
  return children.filter(entry => !omitted.has(entry.name.toLowerCase()) && (entry.isFile() || entry.isDirectory()))
    .map(entry => ({ path: target ? `${target}/${entry.name}` : entry.name, name: entry.name, directory: entry.isDirectory() }));
}

export async function listDirectory(root, target = '') {
  if (target) target = projectPath(root, target) ?? target;
  const [entries, paths] = await Promise.all([directoryEntries(root, target), gitFiles(root)]);
  const prefix = target ? `${target}/` : '';
  const visible = paths && new Set(paths.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]));
  return entries.filter(entry => !visible || visible.has(entry.name))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

async function* walkFiles(root, path = '') {
  for (const entry of await directoryEntries(root, path)) {
    if (entry.directory) yield* walkFiles(root, entry.path);
    else yield entry.path;
  }
}

const foldPath = value => value.normalize('NFKC').toLowerCase().replaceAll('\\', '/');

export async function searchFiles(root, query) {
  const needle = foldPath(typeof query === 'string' ? query.trim().slice(0, 240) : '');
  const words = needle.split(/\s+/).filter(Boolean);
  const matches = [];
  for await (const path of await gitFiles(root) ?? walkFiles(root)) {
    const key = foldPath(path);
    if (!words.every(word => key.includes(word))) continue;
    const name = key.split('/').at(-1);
    const rank = key === needle ? 0 : name === needle ? 1 : name.startsWith(needle) ? 2 : name.includes(needle) ? 3 : 4;
    matches.push({ path, rank });
  }
  matches.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const files = [];
  for (const { path } of matches) {
    const exists = await projectEntry(root, path).then(stat).then(entry => entry.isFile()).catch(() => false);
    if (exists) files.push(path);
    if (files.length === 40) break;
  }
  return files;
}

async function trackedDiff(root, flags, path) {
  const head = await gitIn(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  const args = ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', ...flags];
  if (head) return [await gitIn(root, [...args, 'HEAD', '--', path])];
  return Promise.all([
    gitIn(root, [...args, '--cached', '--', path]),
    gitIn(root, [...args, '--', path]),
  ]);
}

function untrackedFiles(root, path) {
  return gitIn(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path])
    .then(stdout => stdout.split('\0').filter(Boolean));
}

export async function listChanges(root) {
  const prefix = await gitPrefix(root);
  if (prefix === null) return [];
  const output = await gitIn(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'],
    { maxBuffer: 32_000_000 });
  return splitPaths(output).filter(entry => entry.slice(3).startsWith(prefix)).map(entry => ({
    path: entry.slice(3 + prefix.length), staged: entry[0] === ' ' || entry[0] === '?' ? null : entry[0],
    unstaged: entry[1] === ' ' || entry[1] === '?' ? null : entry[1], untracked: entry.startsWith('??'),
  })).filter(entry => visiblePath(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
}

export async function readProjectDiff(root, target, scope = 'all') {
  const path = projectPath(root, target);
  if (!visiblePath(path)) throw new Error('Файл находится вне проекта.');
  if (scope === 'staged' || scope === 'unstaged') {
    return gitIn(root, ['diff', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv',
      ...(scope === 'staged' ? ['--cached'] : []), '--', path]);
  }
  if (scope !== 'all') throw new Error('Неизвестный вид изменений.');
  const diff = (await trackedDiff(root, [], path)).join('');
  if (diff) return diff;
  if (!(await untrackedFiles(root, path)).includes(path)) return '';
  const text = await readProjectFile(root, path);
  if (!text) return 'Новый пустой файл';
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line)].join('\n');
}
