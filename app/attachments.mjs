import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { projectPath } from './activity.mjs';

const maxFiles = 32;
const maxCandidates = 600;
const maxPathsScanned = 4000;
const maxFileBytes = 512_000;
const maxTotalBytes = 2_000_000;
const maxInline = 24_000;
const idPattern = /^[a-f0-9-]{36}$/;
const skipped = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const safeFilename = value => basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') || 'file.txt';

async function readText(path, root) {
  const actual = await realpath(path);
  if ((relative(root, actual) && !projectPath(root, actual)) || relative(path, actual)) throw new Error('Путь файла изменился. Выберите его снова.');
  const entry = await lstat(actual);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Выберите обычный файл.');
  if (entry.size > maxFileBytes) throw new Error('Текстовый файл должен занимать до 512 КБ.');
  const file = await open(actual, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxFileBytes) throw new Error('Текстовый файл должен занимать до 512 КБ.');
    const { buffer, bytesRead } = await file.read(Buffer.alloc(before.size + 1), 0, before.size + 1, 0);
    if (bytesRead !== before.size || (await file.stat()).mtimeMs !== before.mtimeMs) throw new Error('Файл изменился. Повторите выбор.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); } catch {}
    if (text === undefined || text.includes('\0')) throw new Error('Поддерживаются текстовые файлы UTF-8.');
    return { text, size: bytesRead };
  } finally { await file.close(); }
}

export class Attachments {
  picker = null;
  drafts = new Map();
  persistDraft = () => {};

  constructor(home, originalHome) {
    this.home = home;
    this.originalHome = originalHome;
  }

  static async open(root) {
    const original = resolve(root);
    const parent = await realpath(dirname(original));
    return new Attachments(join(parent, basename(original)), original);
  }

  async choose(chatId, input) {
    if (!Array.isArray(input) || input.length > maxFiles) throw new Error('Выберите до 32 файлов или папок.');
    const candidates = [];
    const seen = new Set();
    let scanned = 0;
    let truncated = false;
    const add = (absolute, root, label, size, individual) => {
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      if (seen.has(key)) return;
      if (candidates.length >= maxCandidates) { truncated = true; return; }
      seen.add(key);
      candidates.push({ id: randomUUID(), absolute, root, label, size, individual });
    };
    const visit = async (directory, root, prefix) => {
      if (truncated) return;
      const items = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) return [];
        throw error;
      });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (++scanned > maxPathsScanned || candidates.length >= maxCandidates) { truncated = true; return; }
        if (item.isSymbolicLink() || skipped.has(item.name.toLowerCase())) continue;
        const absolute = join(directory, item.name);
        const label = prefix + '/' + item.name;
        if (item.isDirectory()) await visit(absolute, root, label);
        else if (item.isFile()) {
          const info = await lstat(absolute).catch(() => null);
          if (info?.isFile()) add(absolute, root, label, info.size, false);
        }
      }
    };
    for (const name of input) {
      if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('Файл не выбран.');
      const source = await realpath(name);
      const info = await lstat(source);
      if (info.isDirectory()) await visit(source, source, basename(source) || 'Папка');
      else if (info.isFile()) add(source, source, basename(source), info.size, true);
    }
    const key = randomUUID();
    this.picker = { key, chatId, candidates: new Map(candidates.map(item => [item.id, item])) };
    return { key, truncated, items: candidates.map(({ id, label, size, individual }) => ({
      id, label, size, individual, tooLarge: size > maxFileBytes,
    })) };
  }

  selection(chatId, key) {
    if (this.picker?.key !== key || this.picker.chatId !== chatId) throw new Error('Откройте вложения заново.');
    return this.picker.candidates;
  }

  async preview(chatId, key, id) {
    const item = this.selection(chatId, key).get(id);
    if (!item) throw new Error('Файл не выбран.');
    const { text } = await readText(item.absolute, item.root);
    return { text: text.slice(0, 8000), truncated: text.length > 8000 };
  }

  async attach(chatId, key, ids) {
    const selection = this.selection(chatId, key);
    const existing = this.drafts.get(chatId) ?? new Map();
    if (!Array.isArray(ids) || !ids.length || ids.length + existing.size > maxFiles || new Set(ids).size !== ids.length) {
      throw new Error('Выберите до 32 файлов на сообщение.');
    }
    const items = [];
    let size = [...existing.values()].reduce((sum, file) => sum + file.size, 0);
    for (const id of ids) {
      const candidate = selection.get(id);
      if (!candidate) throw new Error('Файл не выбран.');
      const file = await readText(candidate.absolute, candidate.root);
      size += file.size;
      if (size > maxTotalBytes) throw new Error('Для одного сообщения можно приложить до 2 МБ текста.');
      items.push({ kind: 'external', id, label: candidate.label, filename: safeFilename(candidate.absolute), ...file });
    }
    if (this.picker?.candidates !== selection || (this.drafts.get(chatId) ?? existing) !== existing) {
      throw new Error('Список вложений изменился. Выберите файлы ещё раз.');
    }
    // Keep a bounded number of chat drafts, and allow independent drafts within them.
    if (!this.drafts.has(chatId) && this.drafts.size >= 16) throw new Error('Отправьте или уберите вложения в других черновиках.');
    for (const item of items) existing.set(item.id, item);
    this.drafts.set(chatId, existing);
    this.persistDraft(chatId, [...existing.values()]);
    this.picker = null;
    return items.map(({ text, ...item }) => item);
  }

  remove(chatId, ids) {
    const draft = this.drafts.get(chatId);
    if (!draft) return;
    for (const id of ids) draft.delete(id);
    if (!draft.size) this.drafts.delete(chatId);
    this.persistDraft(chatId, [...draft.values()]);
  }

  files(chatId, ids) {
    if (!Array.isArray(ids) || ids.length > maxFiles || new Set(ids).size !== ids.length) throw new Error('Проверьте список вложений.');
    return ids.map(id => {
      const item = this.drafts.get(chatId)?.get(id);
      if (!item) throw new Error('Файл уже убран из черновика. Прикрепите его заново.');
      return item;
    });
  }

  path(chatId, item) {
    if (!idPattern.test(chatId) || !idPattern.test(item.id) || safeFilename(item.filename) !== item.filename) {
      throw new Error('Некорректный путь вложения.');
    }
    return join(this.home, chatId, item.id, item.filename);
  }

  async save(chatId, files) {
    for (const item of files) {
      const path = this.path(chatId, item);
      await mkdir(dirname(path), { recursive: true });
      if (relative(dirname(path), await realpath(dirname(path)))) throw new Error('Папка вложений изменилась.');
      try { await writeFile(path, item.text, { encoding: 'utf8', flag: 'wx', mode: 0o444 }); }
      catch (error) {
        if (error.code !== 'EEXIST' || (await readText(path, path)).text !== item.text) throw error;
      }
    }
    this.remove(chatId, files.map(item => item.id));
  }

  prompt(chatId, files) {
    if (!files.length) return [];
    let remaining = maxInline;
    const lines = files.map(file => {
      const label = JSON.stringify(file.label);
      if (file.text.length <= remaining && file.text.length <= 12_000) {
        remaining -= file.text.length;
        return '\nВложение ' + label + ' (только чтение):\n' + file.text;
      }
      return '\nВложение ' + label + ' (только чтение; открой встроенным инструментом чтения по этому пути): '
        + JSON.stringify(this.path(chatId, file).replaceAll('\\', '/'));
    });
    return ['\n\nПользователь приложил справочные файлы. Исходники вложений доступны только для чтения. Правки вноси в рабочей папке проекта.',
      ...lines];
  }

  async read(chatId, files, target) {
    if (typeof target !== 'string') return null;
    const path = target.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '').replace(/^\\\\\?\\UNC\\/i, '\\\\');
    const candidate = files.find(item => !relative(this.path(chatId, item), path));
    if (!candidate) return null;
    const full = this.path(chatId, candidate);
    return (await readText(full, full)).text;
  }

  isSnapshot(target, cwd) {
    if (typeof target !== 'string') return false;
    const path = target.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '').replace(/^\\\\\?\\UNC\\/i, '\\\\');
    const full = resolve(cwd, path);
    return Boolean(projectPath(this.home, full) || projectPath(this.originalHome, full));
  }

  async removeChat(chatId) {
    this.drafts.delete(chatId);
    if (this.picker?.chatId === chatId) this.picker = null;
    if (!idPattern.test(chatId)) return;
    const directory = join(this.home, chatId);
    const [root, actual] = await Promise.all([realpath(this.home), realpath(directory)]).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (actual && !relative(directory, actual) && !relative(dirname(actual), root) && basename(actual) === chatId) {
      await rm(actual, { recursive: true, force: true });
    }
  }
}
