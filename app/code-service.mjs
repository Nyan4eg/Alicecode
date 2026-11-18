import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import { stat } from 'node:fs/promises';
import { projectEntry } from './workspace.mjs';

export async function profileConfig(root, profile = {}) {
  let dir = posix.normalize(profile.directory || '.');
  if (posix.isAbsolute(dir) || dir.split('/').includes('..') || dir.includes(':')) throw Error('Некорректная папка профиля.');
  const candidates = [];
  if (profile.config) candidates.push(profile.config);
  else for (;;) {
    for (const name of ['tsconfig.json','jsconfig.json']) candidates.push(posix.join(dir,name));
    if (dir === '.') break;
    dir = posix.dirname(dir);
  }
  for (const path of candidates) {
    try {
      const file = await projectEntry(root,path);
      if (!(await stat(file)).isFile()) throw Error('Ожидался файл конфигурации: ' + path);
      return path;
    } catch (error) {
      if (error.code !== 'ENOENT' || profile.config) throw Error('Не удалось открыть конфигурацию ' + path + ': ' + error.message);
    }
  }
  return null;
}
export async function codeQuery(root, action, input = {}, profile = {}) {
  const config = await profileConfig(root,profile);
  return new Promise((resolve, reject) => {
    const file = fileURLToPath(new URL('./code-worker.mjs', import.meta.url));
    const unpacked = file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const declarations = fileURLToPath(new URL('../../typescript-lib/', import.meta.url));
    const worker = new Worker(pathToFileURL(existsSync(unpacked) ? unpacked : file), { workerData: { root, action, input, config, directory: profile.directory || '.', libRoot: existsSync(declarations) ? declarations : undefined } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Анализ проекта превысил 30 секунд. Уточните рабочую папку.')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Анализатор проекта завершился.')); });
  });
}
