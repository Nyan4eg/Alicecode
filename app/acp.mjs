import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { alias, modelUri, startAdapter } from './adapter.mjs';
import { defaultModel } from './models.mjs';

export async function startRuntime(home, credentials, model = defaultModel) {
  // Keep the ACP model alias stable so existing sessions can load after a model change.
  const adapter = await startAdapter({ ...credentials, modelId: model.id });
  const dispose = () => {
    adapter.server.close();
    adapter.server.closeAllConnections();
  };
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.toml'), [
      '[cli]', 'auto_update = false',
      '[telemetry]', 'enabled = false',
      '[models]', `default = "${alias}"`,
      `[model.${alias}]`, `model = "${modelUri(credentials.folderId, model.id)}"`,
      `base_url = "${adapter.baseUrl}"`, 'env_key = "ALICE_ADAPTER_TOKEN"',
      'api_backend = "chat_completions"', 'temperature = 0', `context_window = ${model.context}`,
    ].join('\n') + '\n');
  } catch (error) {
    dispose();
    throw error;
  }
  const env = { ...process.env };
  for (const name of ['YANDEX_FOLDER_ID', 'YANDEX_API_KEY', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) {
    delete env[name];
  }
  Object.assign(env, {
    GROK_HOME: home,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_TELEMETRY_ENABLED: 'false',
    GROK_MEMORY: '0',
    ALICE_ADAPTER_TOKEN: adapter.token,
  });
  return { env, dispose, modelId: model.id };
}

export class AcpClient {
  pending = new Map();
  nextId = 0;
  closed = false;

  constructor(cwd, runtime, { onUpdate, onPermission }) {
    const installed = join(homedir(), '.grok', 'bin', 'grok.exe');
    const executable = process.platform === 'win32' && existsSync(installed) ? installed : 'grok';
    this.child = spawn(executable, ['agent', 'stdio'], {
      cwd, env: runtime.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.end(error));
    this.child.on('error', error => this.end(error.code === 'ENOENT'
      ? new Error('Grok Build не найден в PATH.') : error));
    this.child.on('close', code => this.end(new Error(`Процесс Grok Build завершился (${code ?? 'signal'}).`)));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.method) {
        const callback = this.pending.get(message.id);
        if (!callback) return;
        this.pending.delete(message.id);
        if (message.error) callback.reject(new Error(message.error.message));
        else callback.resolve(message.result);
        return;
      }
      if (message.method === 'session/update') {
        onUpdate(message.params);
      } else if (message.method === 'session/request_permission') {
        const cancel = { outcome: { outcome: 'cancelled' } };
        Promise.resolve().then(() => onPermission(message.params)).catch(() => cancel)
          .then(result => {
            if (!this.closed) this.send({ id: message.id, result });
          });
      } else if (message.id != null) {
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      }
    });
  }

  end(error) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  send(message) {
    if (this.closed) throw new Error('Соединение с Grok Build закрыто.');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, timeoutMs = 25_000) {
    if (this.closed) return Promise.reject(new Error('Соединение с Grok Build закрыто.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok Build не ответил на ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    if (!this.closed) this.send({ method, params });
  }

  close() {
    this.end(new Error('Сеанс Grok Build закрыт.'));
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }
}
