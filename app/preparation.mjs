import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { commandEnvironment, commandProfile } from './project-commands.mjs';
import { projectEntry, projectFiles } from './workspace.mjs';
import { workspaceMatch } from './repository-profiles.mjs';

const exec = promisify(execFile);
const versionCache = new Map();
const windows = process.platform === 'win32';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function input(root, path) {
  try { return await readFile(await projectEntry(root,path)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function executable(env, name) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  for (const dir of (env[key] ?? '').split(delimiter).map(p=>p.replace(/^"|"$/g,''))) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir,name);
    const info = await stat(file).catch(()=>null);
    if (info?.isFile()) return { file, stamp: info.mtimeMs };
  }
}

async function versions(runtime) {
  const env = await commandEnvironment({runtime});
  const [node,npm] = await Promise.all([executable(env,windows?'node.exe':'node'),executable(env,windows?'npm.cmd':'npm')]);
  const key = JSON.stringify([node,npm]);
  const cached = versionCache.get(key);
  if (cached && Date.now()-cached.time < 10000) return cached.result;
  const options = { env, windowsHide:true, timeout:5000 };
  const version = async (file,args,cwd) => (await exec(file,args,{...options,cwd})).stdout.trim().split(/\r?\n/).at(-1);
  const result = Promise.all([
    node && version(node.file,['--version']).catch(()=>null),
    npm && (windows ? version(process.env.ComSpec || 'cmd.exe',['/d','/c','npm.cmd --version'],dirname(npm.file)) : version(npm.file,['--version'])).catch(()=>null)
  ]).then(([nodeVersion,npmVersion])=>({ node:nodeVersion ?? null,npm:npmVersion ?? null }));
  if (versionCache.size >= 16) versionCache.clear();
  versionCache.set(key,{time:Date.now(),result}); return result;
}

async function inspectInputs(root, selected, general) {
  const profile = selected.commands.prepare ? selected : general.commands.prepare ? general : selected;
  const directory = profile.commands.prepare ? profile.directory || '.' : '.';
  let packageRoot = directory;
  const npmInstall = /^npm(?:\.cmd)?\s+(?:ci|install)(?:\s|$)/i;
  if (directory !== '.' && npmInstall.test(profile.commands.prepare)) {
    const rootManifest = await input(root,'package.json');
    let workspaces;
    try { workspaces = JSON.parse(rootManifest?.toString().replace(/^\uFEFF/, '') ?? '{}').workspaces; } catch {}
    const patterns = workspaces?.packages ?? workspaces;
    if (Array.isArray(patterns) && workspaceMatch(posix.normalize(directory).replace(/\/$/,''),patterns)) packageRoot = '.';
  }
  const local = name => posix.join(packageRoot,name);
  const files = {};
  const read = async path => {
    const bytes = await input(root,path); if (bytes) files[path] = hash(bytes);
    return bytes;
  };
  const shrink = await read(local('npm-shrinkwrap.json'));
  const lock = shrink ? local('npm-shrinkwrap.json') : await read(local('package-lock.json')) ? local('package-lock.json') : null;
  const pkg = await read(local('package.json'));
  const command = profile.commands.prepare || (pkg && lock ? 'npm ci' : '');
  const runtime = profile.runtime || general.runtime;
  const cwd = join(root,directory);
  const modulesDirectory = local('node_modules');
  const installed = (await stat(join(root,modulesDirectory)).catch(()=>null))?.isDirectory() ?? false;
  const tools = pkg || command ? await versions(runtime).catch(()=>({node:null,npm:null})) : {node:null,npm:null};
  let requiresModules = false;
  if (command && pkg) {
    let manifest;
    try { manifest = JSON.parse(pkg.toString().replace(/^\uFEFF/,'')); } catch { manifest = {}; }
    const patterns = manifest.workspaces?.packages ?? manifest.workspaces;
    requiresModules = /^npm(?:\.cmd)?\s+ci(?:\s|$)/i.test(command) && Boolean(
      Object.keys({...manifest.dependencies,...manifest.devDependencies}).length);
    if (Array.isArray(patterns) && patterns.length) {
      for await (const path of await projectFiles(root)) {
        if (posix.basename(path) !== 'package.json') continue;
        const dir = posix.relative(packageRoot,posix.dirname(path));
        if (dir && !dir.startsWith('..') && workspaceMatch(dir,patterns)) {
          await read(path);
          if (/^npm(?:\.cmd)?\s+ci(?:\s|$)/i.test(command)) requiresModules = true;
        }
      }
    }
    await read(local('.npmrc'));
  }
  return { inputs:{command,directory,runtime, ...tools,files}, cwd,lock,installed,requiresModules,modulesDirectory,profile };
}

export class Preparation {
  constructor(store,commands) { this.store=store; this.commands=commands; }
  async inspect(chat, root = chat.cwd) {
    const general = commandProfile(this.store.profile(chat.projectId));
    const selected = commandProfile(this.store.selectedProfile(chat));
    const env = await inspectInputs(root,selected,general);
    const run = this.store.latestPreparation(chat.projectId,root);
    const old = run?.preparation.inputs, now = env.inputs;
    let status = 'needed', reason;
    if (!now.command && old?.command === 'npm ci' && !env.lock) { status = 'blocked'; reason = 'Отсутствует lock-файл npm'; }
    else if (!now.command) { status = 'unconfigured'; reason = 'Команда подготовки не настроена'; }
    else if (run?.status === 'in_progress') { status = 'running'; reason = 'Идёт подготовка'; }
    else if (run && run.status !== 'completed') {
      status = 'failed'; reason = run.status === 'interrupted' ? 'Подготовка прервана' :
        'Ошибка подготовки' + (Number.isInteger(run.exitCode) ? ' · код ' + run.exitCode : '');
    } else if (!old) reason = env.installed ? 'Зависимости найдены, подготовка не подтверждена' : 'Требуется подготовка';
    else if (old.command !== now.command || old.directory !== now.directory) reason = 'Изменилась команда или папка подготовки';
    else if (old.node !== now.node || old.runtime !== now.runtime) reason = 'Изменился Node.js или интерпретатор';
    else if (old.npm !== now.npm) reason = 'Изменилась версия npm';
    else {
      const changed = [...new Set([...Object.keys(old.files),...Object.keys(now.files)])].find(path=>old.files[path] !== now.files[path]);
      if (changed) reason = 'Изменился ' + changed;
      else if ((run.preparation.hadModules || env.requiresModules) && !env.installed) reason = 'Отсутствует node_modules';
      else { status = 'ready'; reason = 'Среда готова'; }
    }
    return { ...env, root,status,reason,runId:run?.id,endedAt:run?.endedAt,chatId:run?.chatId,skipped:run?.preparation.profiles ?? [] };
  }
  async start(chat,root,ids,force=false) {
    const pending = this.commands.preparing;
    if (pending.has(root) || [...this.commands.active.values()].some(entry=>entry.run.root===root)) throw Error('В этой папке уже выполняется команда.');
    pending.add(root);
    let env;
    try {
      env = await this.inspect(chat,root);
      if (!env.inputs.command || this.commands.closing) throw Error(env.reason);
      if (!force && env.status === 'ready') { pending.delete(root); return { id:env.runId }; }
      const run = await this.commands.start({chatId:chat.id,projectId:chat.projectId,root,profile:{...env.profile,runtime:env.inputs.runtime},
        key:'prepare',cwd:env.inputs.directory,command:env.inputs.command,preparation:{inputs:env.inputs,profiles:ids,requiresModules:env.requiresModules,modulesDirectory:env.modulesDirectory}});
      const entry = this.commands.active.get(run.id);
      const done = (entry?.done ?? Promise.resolve(run)).finally(()=>pending.delete(root));
      return { id:run.id,run,done };
    } catch(error) {
      pending.delete(root);
      if (env?.inputs.command && !this.commands.closing) this.commands.save({
        id:randomUUID(),chatId:chat.id,projectId:chat.projectId,root,cwd:env.cwd,profile:env.profile,
        command:env.inputs.command,source:'preparation',preparation:{inputs:env.inputs,profiles:ids},
        startedAt:Date.now(),endedAt:Date.now(),elapsedMs:0,status:'failed',output:error.message,error:error.message
      });
      throw error;
    }
  }
}
