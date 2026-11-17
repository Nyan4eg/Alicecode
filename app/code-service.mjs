import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export function codeQuery(root, action, input = {}) {
  return new Promise((resolve, reject) => {
    const file = fileURLToPath(new URL('./code-worker.mjs', import.meta.url));
    const unpacked = file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    const declarations = fileURLToPath(new URL('../../typescript-lib/', import.meta.url));
    const worker = new Worker(pathToFileURL(existsSync(unpacked) ? unpacked : file), { workerData: { root, action, input, libRoot: existsSync(declarations) ? declarations : undefined } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Анализ проекта превысил 30 секунд. Уточните рабочую папку.')); }, 30000);
    worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Анализатор проекта завершился.')); });
  });
}
