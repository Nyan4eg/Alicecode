import { createHash } from 'node:crypto';
import { projectPath } from './activity.mjs';
import { readProjectFile } from './workspace.mjs';

const maxLines = 300;
const maxChars = 12_000;
const maxFiles = 6;
const maxTotal = 40_000;

export async function previewContext(root, target, start = null, end = null) {
  const path = projectPath(root, target);
  if (!path) throw new Error('Файл находится вне проекта.');
  const text = await readProjectFile(root, path);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const first = start ?? 1;
  const last = end ?? (start ?? lines.length);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > lines.length) {
    throw new Error('Укажите диапазон от 1 до ' + lines.length + '.');
  }
  if (last - first + 1 > maxLines) throw new Error('Выберите не больше ' + maxLines + ' строк.');
  const content = lines.slice(first - 1, last).join('\n');
  if (content.length > maxChars) throw new Error('Выберите фрагмент до 12 000 символов.');
  if (!content.trim()) throw new Error('В выбранном фрагменте нет текста.');
  const digest = createHash('sha256').update(JSON.stringify([path, first, last, content])).digest('hex');
  return { path, start: first, end: last, content, digest };
}

export async function resolveContext(root, items) {
  if (!Array.isArray(items) || items.length > maxFiles) throw new Error('Можно прикрепить до 6 фрагментов.');
  const attachments = await Promise.all(items.map(async ref => {
    if (!ref || typeof ref.digest !== 'string') throw new Error('Сначала просмотрите фрагмент.');
    const item = await previewContext(root, ref.path, ref.start, ref.end);
    if (item.digest !== ref.digest) throw new Error('Файл изменился. Откройте фрагмент заново перед отправкой.');
    return item;
  }));
  if (attachments.reduce((sum, item) => sum + item.content.length, 0) > maxTotal) {
    throw new Error('Общий контекст файлов ограничен 40 000 символов.');
  }
  return attachments;
}

export function contextPrompt({ path, start, end, content }) {
  return '\n\nФрагмент файла ' + JSON.stringify(path) + ', строки ' + start + '–' + end + ':\n' + content;
}
