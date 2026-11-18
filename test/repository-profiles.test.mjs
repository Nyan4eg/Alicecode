import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProfiles, repositoryProfiles, saveRepositoryProfiles, configPath } from '../app/repository-profiles.mjs';
import { Store } from '../app/store.mjs';

test('npm workspaces and JSONC references discover transitive inputs and round-trip portable profiles', async t => {
  const root = await mkdtemp(join(tmpdir(),'alice-repository-'));
  const store = new Store(':memory:');
  t.after(async()=>{store.db.close(); await rm(root,{recursive:true,force:true});});
  const dirs = ['api','web','shared','core','example'];
  for (const dir of dirs) await mkdir(join(root,dir));
  const json = (path,data) => writeFile(join(root,path),JSON.stringify(data));
  await json('package.json',{workspaces:['*','!example']});
  for (const dir of dirs) await json(dir+'/package.json',{name:'@app/'+dir,scripts:['api','web'].includes(dir)?{typecheck:'tsc --noEmit',test:'node --test'}:{},
    dependencies:dir==='api'?{'@app/shared':'*'}:dir==='shared'?{'@app/core':'*'}:{}});
  await writeFile(join(root,'web/tsconfig.json'),'{// relative reference\n"references":[{"path":"../shared/tsconfig.json"},],}');
  await json('shared/tsconfig.json',{});
  const profiles = await discoverProfiles(root);
  assert.deepEqual(profiles.map(p=>p.id),['api','core','shared','web']);
  for (const p of profiles.filter(p=>p.sequence.length)) {
    assert.deepEqual(p.sequence,['types','test']); assert.equal(p.commands.types,'npm run typecheck');
    assert.ok(p.scope.includes('core')); assert.match(p.links.core,/shared.*core/);
  }
  assert.match(profiles.find(p=>p.id==='web').links.shared,/references/);
  const chat = store.addProject('clone',root);
  const local = profiles.filter(p=>p.commands.types);
  store.importProfiles(chat.projectId,local,false);
  store.putProfile(chat,{...local[0],runtime:process.execPath});
  const initial = await repositoryProfiles(store,chat);
  await saveRepositoryProfiles(store,chat,initial.token);
  const saved = await repositoryProfiles(store,chat);
  assert.deepEqual(saved.repo,saved.local); assert.ok(!(await readFile(join(root,configPath),'utf8')).includes('runtime'));
  await assert.rejects(saveRepositoryProfiles(store,chat,initial.token),/изменились/);
  store.importProfiles(chat.projectId,saved.repo,true);
  assert.equal(store.selectedProfile(store.chat(chat.id)).runtime,process.execPath);
  assert.equal(store.chat(chat.id).profileId,'api');
  store.importProfiles(chat.projectId,saved.repo.filter(p=>p.id==='web'),true);
  assert.equal(store.chat(chat.id).profileId,'all');
  await json(configPath,{version:2,profiles:[]});
  await assert.rejects(repositoryProfiles(store,chat),/версии/);
});
