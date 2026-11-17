import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const keyMode = 'key';
export const subscriptionMode = 'subscription';
const apiBase = 'https://ai.api.cloud.yandex.net/v1';
const subscriptionBase = 'https://apps.ai.api.cloud.yandex.net/v1';

export const subscriptionModelIds = ['qwen3.6-35b-a3b', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'aliceai-llm-flash'];

export function validateSubscription({ folderId, iamToken = '', cliProfile = '', tokenSource = 'cli' }) {
  if (typeof folderId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(folderId.trim())) throw new Error('Введите ID каталога облака с подпиской.');
  if (tokenSource === 'cli') {
    if (typeof cliProfile !== 'string' || (cliProfile && !/^[a-zA-Z0-9_.-]{1,80}$/.test(cliProfile.trim()))) {
      throw new Error('Проверьте имя профиля Yandex Cloud CLI.');
    }
    return { mode: subscriptionMode, folderId: folderId.trim(), tokenSource, cliProfile: cliProfile.trim() };
  }
  if (tokenSource !== 'manual' || typeof iamToken !== 'string' || !/^[^\s]{20,8192}$/.test(iamToken.trim())) {
    throw new Error('Вставьте действующий IAM-токен пользователя Yandex Cloud.');
  }
  return { mode: subscriptionMode, folderId: folderId.trim(), tokenSource, iamToken: iamToken.trim() };
}

export async function tokenFromCli(profile) {
  const args = ['iam', 'create-token'];
  if (profile) args.push('--profile', profile);
  try {
    const { stdout } = await exec('yc', args, { windowsHide: true, timeout: 15_000, maxBuffer: 24_000 });
    const token = stdout.trim();
    if (!/^[^\s]{20,8192}$/.test(token)) throw new Error('invalid output');
    return token;
  } catch (error) {
    const problem = new Error(error.code === 'ENOENT'
      ? 'Yandex Cloud CLI (yc) не найден. Установите yc или выберите ввод IAM-токена.'
      : 'Не удалось получить IAM-токен через yc. Проверьте вход и имя профиля Yandex Cloud.');
    problem.name = 'ProviderAuthError';
    throw problem;
  }
}

export function createProvider(credentials, { send = fetch, readToken = tokenFromCli } = {}) {
  const subscribed = credentials.mode === subscriptionMode;
  const base = subscribed ? subscriptionBase : apiBase;
  let cached;
  let expires = 0;

  async function secret(refresh = false) {
    if (!subscribed) return credentials.apiKey;
    if (credentials.tokenSource === 'manual') return credentials.iamToken;
    if (refresh || !cached || Date.now() >= expires) {
      cached = await readToken(credentials.cliProfile);
      expires = Date.now() + 30 * 60_000;
    }
    return cached;
  }

  return {
    model(folderId, id) {
      return 'gpt://' + folderId + '/' + id + (subscribed ? '/latest' : '');
    },
    async request(path, options) {
      if (!['/chat/completions', '/models'].includes(path)) throw new Error('Неизвестная операция провайдера.');
      const request = token => send(base + path, {
        ...options, redirect: 'error',
        headers: { ...options.headers, Authorization: (subscribed ? 'Bearer ' : 'Api-Key ') + token },
      });
      let token = await secret();
      let response = await request(token);
      if (response.status === 401 && subscribed && credentials.tokenSource === 'cli') {
        await response.body?.cancel();
        token = await secret(true);
        response = await request(token);
      }
      return { response, redact: text => token ? text.replaceAll(token, '[redacted]') : text };
    },
  };
}

export function providerError(mode, status) {
  if (mode !== subscriptionMode) return null;
  if (status === 401) return 'Вход в Yandex Cloud истёк. Обновите IAM-токен или проверьте профиль yc.';
  if (status === 403 || status === 404) return 'Проверьте подписку, каталог облака, роль пользователя и доступность модели.';
  if (status === 429) return 'Yandex Cloud ограничил запросы по подписке. Проверьте квоту и попробуйте позже. Оплату по API-ключу можно выбрать вручную.';
  return null;
}
