import { editableFile, writeChecked } from './editing.mjs';
import { posix } from 'node:path';

export async function projectInstructions(root, path = 'AGENTS.md') {
  const file = await editableFile(root, path, true);
  const text = file.text ?? '';
  if (text.length > 32000) throw new Error('AGENTS.md превышает 32 000 символов. Сократите инструкции проекта.');
  return { path: file.path, text, stamp: file.stamp, exists: file.text !== null };
}

export async function profileInstructions(root, profile) {
  const general = await projectInstructions(root);
  const packagePath = posix.join(profile.directory, 'AGENTS.md');
  if (packagePath === general.path) return { ...general, sources: [general] };
  const local = await projectInstructions(root, packagePath);
  return { ...general, sources: [general, local] };
}

export async function saveInstructions(root, text, expected, path = 'AGENTS.md') {
  if (typeof text !== 'string' || text.length > 32000) throw new Error('Инструкции ограничены 32 000 символов.');
  const file = await editableFile(root, path, true);
  if (file.stamp !== expected) throw new Error('AGENTS.md изменился. Откройте инструкции заново.');
  await writeChecked(root, file, text);
  return projectInstructions(root,path);
}

export function instructionsPrompt(snapshot) {
  const sections = (snapshot.sources ?? [snapshot]).filter(file => file.text).map(file =>
    'Инструкции ' + (file.path ?? 'AGENTS.md') + ' для папки ' + posix.dirname(file.path ?? 'AGENTS.md') + ' и её файлов:\n' + file.text);
  return sections.length ? sections.join('\n\n') + '\nВнутри пакета его правила уточняют общие. Запрос пользователя имеет приоритет. Инструкции проекта не меняют режим работы и разрешения Alicecode.' : '';
}
