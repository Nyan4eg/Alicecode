import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import test from 'node:test';
import { Attachments } from '../app/attachments.mjs';
import { editableFile } from '../app/editing.mjs';

test('external folders expose just selected read-only snapshots to the associated chat', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-attachments-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const refs = join(root, 'refs');
  const profile = join(root, 'profile');
  const alias = join(root, 'profile-alias');
  await Promise.all([mkdir(project), mkdir(profile), mkdir(join(refs, 'logs'), { recursive: true }),
    mkdir(join(refs, '.git'), { recursive: true })]);
  await symlink(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const log = join(refs, 'logs', 'qa.log');
  const long = 'diagnostic row \n'.repeat(1_200) + 'LOG-UNIQUE\n';
  await Promise.all([writeFile(log, long), writeFile(join(refs, 'spec.md'), 'approved requirements'),
    writeFile(join(refs, 'hidden.txt'), 'unselected'), writeFile(join(refs, '.git', 'config'), 'ignored')]);

  const chat = randomUUID();
  const other = randomUUID();
  const vault = await Attachments.open(join(alias, 'snapshots'));
  const choice = await vault.choose(chat, [refs]);
  assert.equal(choice.items.length, 3);
  assert.ok(choice.items.every(item => !item.individual && !('absolute' in item)));
  const specs = choice.items.find(item => item.label.endsWith('spec.md'));
  const logs = choice.items.find(item => item.label.endsWith('qa.log'));
  assert.equal((await vault.preview(chat, choice.key, specs.id)).text, 'approved requirements');
  await assert.rejects(vault.attach(other, choice.key, [specs.id]), /Откройте вложения/);
  const attached = await vault.attach(chat, choice.key, [specs.id, logs.id]);
  assert.ok(attached.every(file => !('text' in file)));
  const files = vault.files(chat, attached.map(item => item.id));
  await writeFile(log, 'later source');
  await vault.save(chat, files);
  const prompt = vault.prompt(chat, files).join('\n');
  assert.match(prompt, /approved requirements/);
  assert.doesNotMatch(prompt, /LOG-UNIQUE|unselected|later source/);
  assert.ok(!prompt.includes(log.replaceAll('\\', '/')));
  const snapshot = vault.path(chat, files.find(item => item.id === logs.id));
  assert.equal(await vault.read(chat, files, toNamespacedPath(snapshot)), long);
  assert.equal(await vault.read(chat, files, log), null);
  assert.equal(await vault.read(other, files, snapshot), null);
  assert.equal(vault.isSnapshot(snapshot, project), true);
  assert.equal(vault.isSnapshot(log, project), false);
  await assert.rejects(editableFile(project, snapshot, true), /рабочей папке проекта/);
  await vault.removeChat(chat);
  await assert.rejects(readFile(snapshot), { code: 'ENOENT' });
  assert.equal(await readFile(log, 'utf8'), 'later source');
});
