import { execFile, spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { projectEntry } from './workspace.mjs';

const windows = process.platform === 'win32';
const simpleToken = /"([\p{L}\p{N}_.\/:=+@, -]+)"|'([\p{L}\p{N}_.\/:=+@, -]+)'|([\p{L}\p{N}_.\/:=+@,-]+)/uy;

export function testInvocation(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\r\n]/.test(command)) return null;
  const text = command.trim();
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    simpleToken.lastIndex = offset;
    const match = simpleToken.exec(text);
    if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3]);
    offset = simpleToken.lastIndex;
    if (offset < text.length && !/\s/.test(text[offset])) return null;
    while (offset < text.length && /\s/.test(text[offset])) offset++;
  }
  const [file, ...args] = parts;
  const test = (file === 'node' && args[0] === '--test')
    || (['npm', 'pnpm', 'yarn', 'bun'].includes(file)
      && (args[0] === 'test' || (args[0] === 'run' && /^test(?:[:.-][\w:.-]+)?$/.test(args[1] ?? ''))))
    || (['cargo', 'go', 'dotnet'].includes(file) && args[0] === 'test')
    || (['python', 'python3', 'py'].includes(file) && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]))
    || ['pytest', 'vitest', 'jest'].includes(file) || (file === 'npx' && ['vitest', 'jest'].includes(args[0]));
  return test ? { file, args } : null;
}

export async function replayDetails(root, tool) {
  const invocation = testInvocation(tool?.command);
  if (!invocation || tool?.kind !== 'execute' || !Number.isInteger(tool.exitCode)
    || tool.background || tool.interrupted || typeof tool.cwd !== 'string' || !isAbsolute(tool.cwd)) return null;
  try {
    const base = await projectEntry(root, '', true);
    const cwd = !relative(root, tool.cwd) || !relative(base, tool.cwd) ? base : await projectEntry(base, tool.cwd);
    return { command: tool.command, cwd, invocation };
  } catch {
    return null;
  }
}

export function runTest({ cwd, invocation }, signal) {
  const env = { ...process.env };
  for (const name of ['YANDEX_FOLDER_ID', 'YANDEX_API_KEY', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY',
    'ALICE_ADAPTER_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_TEST_CONTEXT']) delete env[name];
  const { file, args } = invocation;
  const cmdShim = windows && ['npm', 'npx', 'pnpm', 'yarn', 'vitest', 'jest'].includes(file);
  // The parser rejects shell metacharacters. Use cmd only for Windows package-manager shims.
  const executable = cmdShim ? (process.env.ComSpec || 'cmd.exe') : file;
  const parameters = cmdShim ? ['/d', '/v:off', '/s', '/c',
    '"' + [file, ...args.map(arg => arg.includes(' ') ? '"' + arg + '"' : arg)].join(' ') + '"'] : args;

  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn(executable, parameters, {
      cwd, env, windowsHide: true, windowsVerbatimArguments: cmdShim, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stopped = false;
    let truncated = false;
    let error;
    const stop = () => {
      stopped = true;
      if (!child.pid || child.exitCode !== null) return;
      if (windows) execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => child.kill());
      else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    const limit = setTimeout(stop, 240_000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        output += chunk;
        if (output.length > 24_000) {
          truncated = true;
          output = output.slice(-24_000);
        }
      });
    }
    child.once('error', failure => { error = failure.message; });
    child.once('close', (code, childSignal) => {
      clearTimeout(limit);
      signal.removeEventListener('abort', stop);
      if (stopped && !signal.aborted) error = 'Превышено время ожидания команды.';
      resolve({
        exitCode: code, elapsedMs: Math.round(performance.now() - started),
        output: (truncated ? '…\n' : '') + stripVTControlCharacters(output),
        interrupted: stopped || Boolean(childSignal), error,
      });
    });
  });
}
