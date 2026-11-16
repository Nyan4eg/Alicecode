import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export async function listFiles(root) {
  const files = [];
  async function walk(directory, level) {
    if (level > 6 || files.length >= 500) return;
    const dir = await readdir(directory, { withFileTypes: true });
    dir.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of dir) {
      if (files.length >= 500) break;
      if (omitted.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, level + 1);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  }
  await walk(root, 0);
  return files;
}

export async function readProjectFile(root, target) {
  const base = await realpath(root);
  const path = await realpath(resolve(base, target));
  const within = relative(base, path);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)
    || within.split(sep).some(part => omitted.has(part))) {
    throw new Error('Файл находится вне доступной части проекта.');
  }
  const entry = await stat(path);
  if (!entry.isFile() || entry.size > 256_000) throw new Error('Файл слишком большой для просмотра.');
  const content = await readFile(path, 'utf8');
  if (content.includes('\0')) throw new Error('Двоичный файл.');
  return content;
}

function gitIn(root, args) {
  return exec('git', ['--literal-pathspecs', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000,
  }).then(result => result.stdout);
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
  const inGit = await gitIn(root, ['rev-parse', '--is-inside-work-tree']).catch(() => '');
  if (inGit.trim() !== 'true') return [];
  const [tracked, untracked] = await Promise.all([
    trackedDiff(root, ['--name-status', '-z'], '.'),
    untrackedFiles(root, '.'),
  ]);
  const changes = new Map();
  for (const statusList of tracked) {
    const fields = statusList.split('\0');
    for (let index = 0; index < fields.length - 1; index += 2) {
      const [status, path] = fields.slice(index, index + 2);
      const previous = changes.get(path);
      if (previous?.status === 'A' && status === 'D') changes.delete(path);
      else if (previous?.status !== 'A') changes.set(path, { path, status });
    }
  }
  for (const path of untracked) {
    if (!changes.has(path)) changes.set(path, { path, status: '?' });
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function readProjectDiff(root, target) {
  const path = projectPath(root, target);
  if (!path) throw new Error('Файл находится вне проекта.');
  const diff = (await trackedDiff(root, [], path)).join('');
  if (diff) return diff;
  if (!(await untrackedFiles(root, path)).includes(path)) return '';
  const text = await readProjectFile(root, path);
  if (!text) return 'Новый пустой файл';
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line)].join('\n');
}
