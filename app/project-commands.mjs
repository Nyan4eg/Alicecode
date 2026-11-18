import { spawn, execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, delimiter, relative, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { projectEntry } from './workspace.mjs';
import { nodeTestCounts } from './activity.mjs';
import { checkKind, fileRevision } from './revision.mjs';

export const commandLabels = { prepare: 'Подготовить ветку', install: 'Зависимости', types: 'Типы', test: 'Тесты', build: 'Сборка', start: 'Запустить приложение' };
export function commandProfile(value = {}) {
  const text = (input, limit) => { if (typeof input !== 'string' || input.length > limit || input.includes('\0')) throw new Error('Некорректные настройки команд.'); return input.trim(); };
  const commands = {};
  for (const key of Object.keys(commandLabels)) commands[key] = text(value.commands?.[key] ?? '', 3000);
  const directory = text(value.directory ?? '', 500).replaceAll('\\', '/');
  if (isAbsolute(directory) || /^[a-z]:/i.test(directory) || directory.split('/').includes('..')) throw new Error('Рабочая папка должна находиться внутри проекта.');
  const scope = [...new Set((value.scope ?? []).map(item => text(item, 500).replaceAll('\\','/').replace(/\/+$/, '')))];
  if (scope.length > 100 || scope.some(path => !path || path.split('/').some(part => !part || ['..','.','.git'].includes(part)) || /[:*?\[\]]/.test(path))) throw Error('Укажите относительные файлы и папки без шаблонов.');
  const sequence = value.sequence ?? ['types','test','build'].filter(key => commands[key]);
  if (!Array.isArray(sequence) || sequence.length > 3 || new Set(sequence).size !== sequence.length || sequence.some(key => !['types','test','build'].includes(key) || !commands[key])) throw Error('Для каждого шага проверки нужна настроенная команда.');
  const id = value.id ?? 'all', name = text(value.name ?? 'Весь проект', 60);
  if (!name || !/^(all|[a-zA-Z0-9_-]{1,64})$/.test(id)) throw Error('Некорректный профиль.');
  const config = text(value.config ?? '',500).replaceAll('\\','/');
  if (config && (!config.endsWith('.json') || /[:*?]/.test(config) || config.split('/').some(part => !part || part === '..'))) throw Error('Укажите путь к файлу JSON от корня проекта.');
  const links = Object.fromEntries(scope.filter(path => Object.hasOwn(value.links ?? {}, path))
    .map(path => [path, text(value.links[path], 1000)]));
  return { id, name, commands, directory, config, scope, sequence, runtime: text(value.runtime ?? '', 1000),
    ...(Object.keys(links).length ? { links } : {}) };
}
export async function commandEnvironment(profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (profile.runtime) {
    if (!isAbsolute(profile.runtime) || !(await stat(profile.runtime)).isFile()) throw new Error('Выбранный интерпретатор не найден.');
    const key = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[key] = dirname(profile.runtime) + delimiter + (env[key] ?? '');
  }
  return env;
}
export async function commandDirectory(root, profile) {
  const cwd = await projectEntry(root, profile.directory === '.' ? '' : profile.directory, true);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Рабочая папка команды не найдена.');
  return cwd;
}
export function commandsPrompt(profile, root) {
  return 'Профиль команд «' + profile.name + '». Выполняй команды в рабочей папке относительно ' + JSON.stringify(root) + ': ' + JSON.stringify(profile.directory || '.')
    + (profile.runtime ? '\nИнтерпретатор: ' + JSON.stringify(profile.runtime) : '')
    + '\n' + Object.entries(profile.commands).filter(([, command]) => command).map(([key, command]) => commandLabels[key] + ': ' + command).join('\n')
    + '\nИспользуй эти команды для соответствующих действий. Дожидайся окончания тестов и сборки. Команда запуска сервера может работать до остановки.';
}

export class CommandRuns {
  active = new Map();
  batches = new Map();
  preparing = new Set();
  constructor(store, publish) { this.store = store; this.publish = publish; }
  save(run) { this.store.saveCommand(run); this.publish(run); }
  async fingerprint(root, profile) {
    const revision = await fileRevision(root, profile?.scope);
    if (!revision) return null;
    this.store.db.prepare('INSERT OR IGNORE INTO check_files(version,files) VALUES (?,?)')
      .run(revision.version, JSON.stringify(revision.files));
    return revision.version;
  }
  async sequence(details) {
    if (this.preparing.has(details.root)) throw Error('Дождитесь завершения подготовки среды.');
    const profile = commandProfile(details.profile);
    if (!profile.sequence.length) throw Error('Настройте шаги проверки в командах проекта.');
    if (this.batches.get(details.chatId) !== details.batch || [...this.active.values()].some(({ run }) => run.steps && run.chatId === details.chatId)) throw Error('Проверка уже выполняется.');
    const run = { id: randomUUID(), chatId: details.chatId, projectId: details.projectId, root: details.root,
      cwd: details.root, profile, command: 'Проверить задачу', source: 'sequence', status: 'in_progress', startedAt: Date.now(),
      preparedRunId: details.preparedRunId, steps: profile.sequence.map(key => ({ key, status: 'pending' })), output: '' };
    let stopped = false, childId, currentStep;
    const stop = () => { stopped = true; this.active.get(childId)?.stop(); };
    const execute = async () => {
      try {
        run.cwd = await commandDirectory(details.root, profile);
        for (const step of run.steps) {
          if (stopped) break;
          currentStep = step;
          const child = await this.start({ ...details, profile, key: step.key });
          childId = step.runId = child.id;
          step.status = 'in_progress'; this.save(run);
          const entry = this.active.get(child.id);
          if (stopped) entry?.stop();
          const result = entry ? await entry.done : child;
          step.status = result.status;
          run.output += commandLabels[step.key] + ' · ' + result.command + ' · код ' + (result.exitCode ?? '—') + '\n';
          if (result.status !== 'completed') run.output += result.output.slice(-12000);
          if (result.status !== 'completed') break;
        }
      } catch (error) { run.error = error.message; if (currentStep) currentStep.status = 'failed'; }
      run.status = stopped ? 'interrupted' : run.steps.every(s => s.status === 'completed') ? 'completed' : 'failed';
      for (const step of run.steps) if (step.status === 'pending') step.status = 'skipped';
      run.endedAt = Date.now(); run.elapsedMs = run.endedAt - run.startedAt;
      this.active.delete(run.id); this.save(run);
    };
    this.active.set(run.id, { run, stop, done: Promise.resolve().then(execute) });
    this.save(run); return run;
  }
  async start(details) {
    const profile = commandProfile(details.profile);
    const command = details.command ?? profile.commands[details.key];
    if (typeof command !== 'string' || !command.trim() || command.length > 3000 || command.includes('\0')) throw new Error('Сначала настройте команду проекта.');
    const cwd = await commandDirectory(details.root, details.cwd ? { ...profile, directory: details.cwd } : profile);
    const env = await commandEnvironment(profile);
    if (this.closing) throw Error('Приложение завершает работу.');
    const windows = process.platform === 'win32';
    const run = { id: randomUUID(), chatId: details.chatId, projectId: details.projectId, root: details.root, cwd,
      command, profile, label: commandLabels[details.key] ?? 'Повтор команды', source: 'project', status: 'in_progress',
      startedAt: Date.now(), elapsedMs: 0, output: '', exitCode: null };
    run.check = checkKind(command, profile, details.key);
    if (details.preparation) { run.source = 'preparation'; run.preparation = details.preparation; run.check = null; }
    if (run.check) run.version = await this.fingerprint(details.root, profile);
    if (!details.preparation && this.preparing.has(details.root)) throw Error('Дождитесь завершения подготовки среды.');
    const child = spawn(windows ? 'powershell.exe' : '/bin/sh', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\n" + command + '\nexit $LASTEXITCODE'] : ['-c', command],
    { cwd, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    let timer, stopping = false, failure;
    let finished;
    const done = new Promise(resolve => { finished = resolve; });
    const publish = () => { clearTimeout(timer); timer = null; run.elapsedMs = Date.now() - run.startedAt; this.save(run); };
    const stop = () => {
      stopping = true;
      if (!child.pid || child.exitCode !== null) return;
      if (windows) execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => child.kill());
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500).unref(); }
    };
    this.active.set(run.id, { run, stop, done }); publish();
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.setEncoding('utf8'); stream.on('data', chunk => {
        const clean = stripVTControlCharacters(chunk); run.output += clean;
        if (name === 'stderr') run.stderr = ((run.stderr ?? '') + clean).slice(-16000);
        if (run.output.length > 128000) { run.output = run.output.slice(-128000); run.truncated = true; }
        timer ??= setTimeout(publish, 80);
      });
    }
    child.once('error', error => { failure = error.message; });
    child.once('close', (code, signal) => {
      run.exitCode = code; run.status = stopping || signal ? 'interrupted' : code === 0 ? 'completed' : 'failed';
      run.error = failure; run.endedAt = Date.now(); run.tests = nodeTestCounts(run.output);
      if (run.preparation && run.status === 'completed') {
        try { run.preparation.hadModules = Boolean(statSync(join(run.root,run.preparation.modulesDirectory),{throwIfNoEntry:false})?.isDirectory()); }
        catch { run.preparation.hadModules = false; }
        if (run.preparation.requiresModules && !run.preparation.hadModules) {
          run.status = 'failed'; run.error = 'После подготовки отсутствует node_modules.'; run.output += '\n' + run.error;
        }
      }
      this.active.delete(run.id); publish(); finished(run);
    });
    return run;
  }
  stop(id) { const entry = this.active.get(id); if (!entry) throw new Error('Команда уже завершилась.'); entry.stop(); }
  async close() { this.closing = true; this.batches.clear(); const entries = [...this.active.values()]; for (const entry of entries) entry.stop(); await Promise.all(entries.map(entry => entry.done)); }
  recordAgent(turn, tool) {
    if (!tool.command || tool.decision && !tool.status) return;
    const id = 'agent:' + turn.message.id + ':' + tool.id;
    const prior = this.store.command(id);
    const run = { ...prior, id, chatId: turn.chatId, projectId: this.store.chat(turn.chatId).projectId,
      messageId: turn.message.id, toolId: tool.id, root: turn.cwd, cwd: tool.cwd ?? turn.cwd,
      source: 'agent', label: 'Алиса', command: tool.command, output: tool.output ?? '',
      startedAt: prior?.startedAt ?? Date.now(), status: tool.background ? 'background' : tool.interrupted ? 'interrupted' : tool.status,
      exitCode: tool.exitCode, tests: tool.tests };
    run.profile = turn.replayProfile ?? turn.message.task?.profile;
    run.check = checkKind(run.command, run.profile);
    if (run.check) {
      const expected = resolve(turn.cwd, run.profile?.directory || '.');
      run.version = run.profile?.scope?.length && relative(expected,resolve(turn.cwd,run.cwd)) !== ''
        ? null : turn.checkVersions?.get(tool.id) ?? null;
    }
    run.elapsedMs = Date.now() - run.startedAt;
    if (['completed', 'failed', 'interrupted'].includes(run.status)) run.endedAt = Date.now();
    this.save(run);
  }
  finishAgent(messageId) {
    for (const run of this.store.commands().filter(run => run.messageId === messageId && ['pending', 'in_progress', 'background'].includes(run.status))) {
      this.save({ ...run, status: 'interrupted', error: 'Задача завершена; завершение этой команды не подтверждено.', endedAt: Date.now() });
    }
  }
}
