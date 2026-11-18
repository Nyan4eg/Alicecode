import { posix, matchesGlob } from 'node:path';
import { commandProfile } from './project-commands.mjs';
import { editableFile, fingerprint, writeChecked } from './editing.mjs';
import { projectFiles } from './workspace.mjs';

export const configPath = '.alicecode/project.json';
const scriptNames = { types: ['typecheck','type-check','check:types','types'], test: ['test'], build: ['build'], start: ['start','dev'] };

function portable(profile) {
  const { runtime, commands, ...fields } = commandProfile(profile);
  return { ...fields, commands: Object.fromEntries(Object.entries(commands).filter(([,cmd]) => cmd)) };
}

export function localProfiles(store, projectId) {
  return store.profiles(projectId).map(portable)
    .filter(p => p.id !== 'all' || p.directory || p.scope.length || p.config || Object.keys(p.commands).length)
    .sort((a,b) => a.id.localeCompare(b.id));
}

function parseConfig(text) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error(configPath + ' содержит ошибку JSON.'); }
  if (data?.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 100) throw Error('Ожидается конфигурация версии 1 со списком профилей.');
  const profiles = data.profiles.map(p => {
    if (!p || typeof p.id !== 'string' || !p.name || !p.commands || typeof p.commands !== 'object' || Array.isArray(p.commands) || p.runtime)
      throw Error('Проверьте имя, команды и переносимость профиля в ' + configPath);
    return portable(p);
  }).sort((a,b) => a.id.localeCompare(b.id));
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw Error('Повторяется идентификатор профиля.');
  return profiles;
}

export async function repositoryProfiles(store, chat) {
  const file = await editableFile(chat.projectCwd, configPath, true);
  const local = localProfiles(store, chat.projectId);
  const repo = file.text === null ? null : parseConfig(file.text);
  return { local, repo, stamp: file.stamp, token: fingerprint(JSON.stringify([file.stamp,local])) };
}

export async function saveRepositoryProfiles(store, chat, token) {
  const current = await repositoryProfiles(store,chat);
  if (current.token !== token) throw Error('Настройки изменились. Откройте сравнение заново.');
  for (const p of current.local) for (const cmd of Object.values(p.commands)) {
    if (/(?:[a-z]:[\\/]|(?:^|[\s"'])\\\\[^\\]|(?:^|[\s"'])\/(?:Users|home|opt|usr|tmp)\/)/i.test(cmd))
      throw Error('Замените путь к локальной программе в команде профиля «' + p.name + '» переносимой командой.');
  }
  const file = await editableFile(chat.projectCwd,configPath,true);
  if (file.stamp !== current.stamp) throw Error('Файл настроек изменился. Откройте сравнение заново.');
  const content = JSON.stringify({version:1, profiles:current.local},null,2) + '\n';
  parseConfig(content);
  await writeChecked(chat.projectCwd,file,content);
}

function workspaceMatch(dir, patterns) {
  let included = false;
  for (const raw of patterns) {
    if (typeof raw !== 'string') throw Error('Проверьте список workspaces в package.json.');
    const pattern = raw.replace(/^!/, '').replace(/^\.\//,'').replace(/\/+$/,'');
    if (pattern && matchesGlob(dir,pattern)) included = !raw.startsWith('!');
  }
  return included;
}

export async function discoverProfiles(root, existing = []) {
  const manifest = async path => {
    const file = await editableFile(root,path);
    try { return JSON.parse(file.text.replace(/^\uFEFF/,'')); } catch { throw Error('Ошибка JSON в ' + path); }
  };
  const main = await manifest('package.json');
  const patterns = main.workspaces?.packages ?? main.workspaces ?? [];
  if (!Array.isArray(patterns)) throw Error('Ожидается список каталогов npm workspaces.');
  const dirs = new Set(['']), files = new Set();
  for await (const path of await projectFiles(root)) {
    if (posix.basename(path) === 'package.json' && workspaceMatch(posix.dirname(path),patterns)) dirs.add(posix.dirname(path));
    if (['tsconfig.json','jsconfig.json','package-lock.json','npm-shrinkwrap.json'].includes(posix.basename(path))) files.add(path);
  }
  if (dirs.size > 100) throw Error('Найдено более 100 пакетов. Уточните workspaces.');
  const packages = [], used = new Set(['all',...existing.map(p => p.id)]);
  for (const directory of [...dirs].sort()) {
    const pkg = directory ? await manifest(posix.join(directory,'package.json')) : main;
    const name = pkg.name || directory || 'Весь проект';
    const prior = existing.find(p => p.directory === directory);
    let id = directory ? prior?.id : 'all';
    if (!id) {
      const slug = directory.replace(/[^a-z0-9_-]/gi,'-').slice(0,50) || 'package';
      id = used.has(slug) ? slug + '-' + fingerprint(directory).slice(0,10) : slug;
    }
    used.add(id);
    const commands = {};
    for (const [kind,names] of Object.entries(scriptNames)) {
      const script = names.find(key => typeof pkg.scripts?.[key] === 'string' && pkg.scripts[key].trim());
      if (script) commands[kind] = 'npm run ' + script;
    }
    const config = ['tsconfig.json','jsconfig.json'].map(f => posix.join(directory,f)).find(f => files.has(f)) ?? '';
    const references = [];
    if (config) {
      const ts = (await import('typescript')).default;
      const result = ts.parseConfigFileTextToJson(config,(await editableFile(root,config)).text);
      if (result.error) throw Error('Ошибка в ' + config);
      for (const ref of result.config.references ?? []) {
        if (typeof ref?.path === 'string') references.push(posix.normalize(posix.join(directory,ref.path.replaceAll('\\','/'))).replace(/\/$/,''));
      }
    }
    packages.push({ id,name,directory,config,commands,references,deps:Object.keys({...pkg.dependencies,...pkg.devDependencies,...pkg.peerDependencies,...pkg.optionalDependencies}) });
  }
  return packages.filter(p => p.directory || Object.keys(p.commands).length).map(p => {
    const links = {}, visited = new Set([p]);
    const visit = (owner, chain) => {
      for (const dep of packages) {
        if (!dep.directory || visited.has(dep)) continue;
        const reference = owner.references.includes(dep.directory) || (dep.config && owner.references.includes(dep.config));
        if (!reference && !owner.deps.includes(dep.name)) continue;
        visited.add(dep);
        const reason = chain + ' → ' + dep.name + (reference ? ' (tsconfig references)' : ' (package.json)');
        links[dep.directory] = reason;
        visit(dep,reason);
      }
    };
    visit(p,p.name);
    const scope = p.directory ? [p.directory,...Object.keys(links),'package.json',...['package-lock.json','npm-shrinkwrap.json'].filter(f=>files.has(f))] : [];
    return portable({...p,name:p.name.slice(0,60),scope,links});
  });
}
