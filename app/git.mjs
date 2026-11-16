import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectPath } from './activity.mjs';
import { fingerprint } from './editing.mjs';
import { gitIn, listChanges } from './workspace.mjs';

const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--full-index', '--no-relative',
  '--src-prefix=a/', '--dst-prefix=b/'];
const unresolved = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export async function repositoryRoot(root) {
  const path = await gitIn(root, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!path) throw new Error('Откройте рабочую папку Git.');
  return realpath(path.replace(/\r?\n$/, ''));
}

async function changedFile(root, target) {
  const relative = projectPath(root, target);
  const file = relative && (await listChanges(root)).find(item => item.path === relative);
  if (!file) throw new Error('Список изменений обновился. Выберите файл заново.');
  if (unresolved.has((file.staged ?? ' ') + (file.unstaged ?? ' '))) throw new Error('Сначала разрешите конфликт Git.');
  const repo = await repositoryRoot(root);
  return { file, repo, path: projectPath(repo, resolve(root, relative)) };
}

export async function stageFile(root, target, staged) {
  const { file, repo, path } = await changedFile(root, target);
  if (staged && (file.unstaged || file.untracked)) await gitIn(repo, ['add', '-A', '--', path]);
  if (!staged && file.staged) {
    const head = await gitIn(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, error => {
      if (error.code === 1) return false;
      throw error;
    });
    if (head) await gitIn(repo, ['restore', '--staged', '--', path]);
    else await gitIn(repo, ['rm', '--cached', '-f', '--', path]);
  }
}

async function hunkSource(root, target, scope) {
  if (scope !== 'staged' && scope !== 'unstaged') throw new Error('Выберите сторону индекса Git.');
  const { file, repo, path } = await changedFile(root, target);
  if (file[scope] !== 'M') throw new Error('Выберите изменённый текстовый файл для работы с фрагментами.');
  const diff = await gitIn(repo, ['diff', ...diffOptions, ...(scope === 'staged' ? ['--cached'] : []), '--', path]);
  const start = diff.indexOf('\n@@ ');
  if (start === -1) throw new Error('В этом изменении нет текстовых фрагментов.');
  const header = diff.slice(0, start + 1).split('\n')
    .filter(line => !/^(old mode |new mode )/.test(line)).join('\n');
  const hunks = diff.slice(start + 1).split(/(?<=\n)(?=@@ )/);
  return { repo, header, hunks, token: fingerprint(diff) };
}

export async function gitHunks(root, path, scope) {
  const { hunks, token } = await hunkSource(root, path, scope);
  return { hunks, token };
}

export async function stageHunks(root, path, scope, selected, token) {
  const source = await hunkSource(root, path, scope);
  if (token !== source.token) throw new Error('Diff изменился. Заново выберите фрагменты.');
  if (!Array.isArray(selected) || !selected.length
    || selected.some(index => !Number.isInteger(index) || index < 0 || index >= source.hunks.length)) {
    throw new Error('Выберите фрагменты.');
  }
  const indices = [...new Set(selected)].sort((a, b) => a - b);
  const patch = source.header + indices.map(index => source.hunks[index]).join('');
  const args = ['apply', '--cached', '--whitespace=nowarn', ...(scope === 'staged' ? ['--reverse'] : [])];
  await gitIn(source.repo, [...args, '--check', '-'], { input: patch });
  await gitIn(source.repo, [...args, '-'], { input: patch });
}

export async function commitPreview(root) {
  const repo = await repositoryRoot(root);
  const [branch, head, diff, files, conflicts] = await Promise.all([
    gitIn(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => value.trim(), () => 'HEAD (detached)'),
    gitIn(repo, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim(), () => null),
    gitIn(repo, ['diff', '--cached', ...diffOptions], { maxBuffer: 8_000_000 }),
    gitIn(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames'], { maxBuffer: 3_000_000 }),
    gitIn(repo, ['ls-files', '--unmerged', '-z']),
  ]);
  if (conflicts) throw new Error('Сначала разрешите конфликты Git.');
  return { repo, branch, diff, paths: files.split('\0').filter(Boolean),
    token: fingerprint(JSON.stringify([repo, branch, head, diff, files])) };
}

export async function createCommit(root, token, input) {
  const message = typeof input === 'string' ? input.trim() : '';
  if (!message || message.length > 4000 || message.includes('\0')) throw new Error('Введите сообщение коммита до 4 000 символов.');
  const preview = await commitPreview(root);
  if (token !== preview.token) throw new Error('Ветка или индекс изменились. Проверьте состав коммита заново.');
  if (!preview.paths.length) throw new Error('Добавьте изменения в индекс Git.');
  await gitIn(preview.repo, ['commit', '-m', message], { timeout: 120_000 });
  return (await gitIn(preview.repo, ['rev-parse', '--short', 'HEAD'])).trim();
}
