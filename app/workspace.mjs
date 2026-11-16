import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

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

export async function listChanges(root) {
  const git = async args => (await exec('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2_000_000,
  })).stdout;
  const prefix = (await git(['rev-parse', '--show-prefix']).catch(() => null))?.trim();
  if (prefix !== '') return [];

  const hasHead = await git(['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  const diff = hasHead
    ? await git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.'])
    : (await git(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--', '.']))
      + (await git(['diff', '--no-ext-diff', '--no-textconv', '--', '.']));
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
  const added = untracked.split('\0').filter(Boolean).slice(0, 50);
  const changes = diff ? [{ name: 'Изменения Git', diff }] : [];
  for (const name of added) {
    const text = await readProjectFile(root, name).catch(() => null);
    changes.push({
      name, diff: text === null ? 'Новый файл' : text.split(/\r?\n/).map(line => '+' + line).join('\n'),
    });
  }
  return changes;
}
