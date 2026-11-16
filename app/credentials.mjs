import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function validateCredentials({ folderId, apiKey }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId ?? '') || !apiKey?.trim() || /[\r\n]/.test(apiKey)) {
    throw new Error('Введите ID каталога и секретную часть API-ключа.');
  }
  return { folderId, apiKey: apiKey.trim() };
}

export async function readPrototypeCredentials() {
  if (!process.env.LOCALAPPDATA) return null;
  const path = join(process.env.LOCALAPPDATA, 'Alicecode', 'yandex-ai-studio.xml');
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$credential = Import-Clixml -LiteralPath $env:ALICECODE_CREDENTIAL_FILE',
    '@{folderId=$credential.UserName;apiKey=$credential.GetNetworkCredential().Password} | ConvertTo-Json -Compress',
  ].join('\n');
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ALICECODE_CREDENTIAL_FILE: path }, windowsHide: true, timeout: 10_000,
    });
    return validateCredentials(JSON.parse(stdout));
  } catch {
    throw new Error('Не удалось прочитать сохранённый ключ Windows. Введите ключ в настройках Alicecode.');
  }
}
