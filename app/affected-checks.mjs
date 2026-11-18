import { resolve } from 'node:path';
import { projectPath } from './activity.mjs';
import { commandProfile } from './project-commands.mjs';
import { fileRevision } from './revision.mjs';
import { Preparation } from './preparation.mjs';
import { gitIn, gitPrefix, listChanges } from './workspace.mjs';

function checkSettings(profile) {
  return JSON.stringify([profile.directory, profile.runtime, profile.config, [...profile.scope].sort(),
    profile.sequence.map(key => [key, profile.commands[key]])]);
}

export function affectedPaths(profile, paths) {
  return paths.filter(path => !profile.scope.length || profile.scope.some(scope => path === scope || path.startsWith(scope + '/')));
}

function firstProblem(run) {
  const lines = (run?.output || run?.error || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = /^(.+?)\((\d+),\d+\):\s*(?:error|warning)\b/i.exec(line)
      ?? /^(.+?\.[\w]+):(\d+)(?::\d+)?(?:\s|:)/.exec(line);
    if (!match) continue;
    const path = projectPath(run.root, resolve(run.cwd, match[1]));
    if (path) return { text: line, path, line: Number(match[2]) };
  }
  return { text: lines.find(line => /error|fail|ошиб|not ok/i.test(line)) ?? lines[0] ?? 'Откройте вывод проверки.' };
}

async function changedPaths(chat) {
  if (await gitPrefix(chat.cwd) === null) return null;
  const paths = new Set((await listChanges(chat.cwd)).map(item => item.path));
  if (chat.workspace?.base) {
    const diff = await gitIn(chat.cwd, ['diff','--relative','--no-renames','--name-only','-z',chat.workspace.base,'--','.']);
    for (const path of diff.split('\0')) if (path) paths.add(path);
  }
  return [...paths].sort();
}

export class AffectedChecks {
  constructor(store, commands) { this.store = store; this.commands = commands; this.preparation = new Preparation(store,commands); }

  async summary(chat, onlyProfile, environment) {
    environment ??= await this.preparation.inspect(chat);
    const paths = onlyProfile ? [] : await changedPaths(chat);
    const uncovered = new Set(paths);
    const rows = [];
    for (const profile of this.store.profiles(chat.projectId).map(commandProfile)) {
      if (onlyProfile && onlyProfile !== profile.id) continue;
      if (profile.id === 'all' && !profile.sequence.length) continue;
      const reasons = affectedPaths(profile, paths ?? []);
      if (profile.sequence.length) for (const path of reasons) uncovered.delete(path);
      const run = this.store.latestSequence(chat.id, chat.cwd, profile.id);
      let status = run?.status ?? 'missing', failure, problem;
      if (run && ['completed','failed'].includes(status)) {
        const steps = run.steps.map(step => step.runId && this.store.command(step.runId)).filter(Boolean);
        const failed = steps.find(step => step.status === 'failed');
        if (status === 'failed') {
          failure = failed?.id;
          problem = firstProblem(failed ?? run);
        }
        if (checkSettings(profile) !== checkSettings(commandProfile(run.profile))) status = 'stale';
        else if (steps.length && steps.every(step => step.version)) {
          const version = (await fileRevision(chat.cwd, profile.scope))?.version;
          if (!version) status = status === 'completed' ? 'unknown' : status;
          else if (steps.some(step => step.version !== version)) status = 'stale';
        } else if (status === 'completed') status = 'unknown';
      }
      if (environment.status === 'failed' && environment.chatId === chat.id && environment.skipped.includes(profile.id)) status = 'skipped';
      else if (environment.runId && environment.status !== 'unconfigured' && ['completed','failed'].includes(status) &&
        (environment.status !== 'ready' || (run.preparedRunId ? run.preparedRunId !== environment.runId : run.startedAt < environment.endedAt))) status = 'stale';
      rows.push({ id: profile.id, name: profile.name, configured: Boolean(profile.sequence.length),
        reasons, links: profile.links, status, runId: run?.id, failure, problem });
    }
    return { rows, uncovered: [...uncovered], git: paths !== null, environment };
  }

  async run(chat, ids, report) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw Error('Выберите профили для проверки.');
    const profiles = this.store.profiles(chat.projectId).map(commandProfile);
    const selected = [...new Set(ids)].map(id => profiles.find(p => p.id === id));
    if (selected.some(p => !p?.sequence.length)) throw Error('Проверьте настройки выбранных профилей.');
    const batch = this.commands.batches;
    if (batch.has(chat.id) || [...batch.values()].some(item => item.root === chat.cwd)) throw Error('Проверки уже выполняются.');
    const token = {root:chat.cwd};
    batch.set(chat.id, token);
    try {
      let environment = await this.preparation.inspect(chat);
      if (environment.status === 'blocked') throw Error(environment.reason);
      if (environment.inputs.command && environment.status !== 'ready') {
        if (batch.get(chat.id) !== token) return;
        const preparation = await this.preparation.start(chat,chat.cwd,ids);
        const finished = await preparation.done;
        if (finished && finished.status !== 'completed') return;
        environment = await this.preparation.inspect(chat);
        if (environment.status !== 'ready') throw Error(environment.reason);
      }
      for (const profile of selected) {
        if (batch.get(chat.id) !== token) break;
        const { rows } = await this.summary(chat, profile.id,environment);
        if (rows[0]?.status === 'completed') {
          report?.({ ...rows[0], reused: true });
          continue;
        }
        if (batch.get(chat.id) !== token) break;
        const run = await this.commands.sequence({ chatId: chat.id, projectId: chat.projectId, root: chat.cwd, profile, batch: token,preparedRunId:environment.status === 'ready' ? environment.runId : undefined });
        report?.({ id: profile.id, status: 'in_progress', runId: run.id });
        await this.commands.active.get(run.id)?.done;
        if (report) {
          const outcome = await this.summary(chat, profile.id, environment);
          report(outcome.rows[0]);
        }
        if (run.status === 'interrupted') break;
      }
    } finally { if (batch.get(chat.id) === token) batch.delete(chat.id); }
  }
}
