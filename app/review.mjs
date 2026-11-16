import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gitIn, gitPrefix, listChanges, projectEntry } from './workspace.mjs';

const maxFile = 256_000;
const maxPaths = 400;
const maxBaseline = 16_000_000;
const maxPatches = 1_500_000;
const unavailable = Symbol('unavailable');
const unavailableGit = { state: 'unavailable', files: [], note: 'Сравнение за запуск доступно в рабочей папке Git.' };

function fileVersion(bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n');
    if (!text.includes('\0')) return { text };
  } catch {
    // Binary files still have a comparable fingerprint.
  }
  return { digest };
}

async function currentFile(root, path) {
  let file;
  try {
    if ((await lstat(resolve(root, path))).isSymbolicLink()) return unavailable;
    const resolved = await projectEntry(root, path);
    file = await open(resolved, 'r');
    const entry = await file.stat();
    if (!entry.isFile()) return null;
    const buffer = Buffer.alloc(entry.size <= maxFile ? entry.size + 1 : 0);
    if (!buffer.length) return unavailable;
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxFile || (await file.stat()).size !== bytesRead) return unavailable;
    return fileVersion(buffer.subarray(0, bytesRead));
  } catch (error) {
    return ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? null : unavailable;
  } finally {
    await file?.close();
  }
}

async function gitHead(root) {
  return gitIn(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(stdout => stdout.trim(), error => {
    if (error.code === 1) return null;
    throw error;
  });
}

async function headFile(root, head, path) {
  if (!head) return null;
  const tree = await gitIn(root, ['ls-tree', '-z', head, '--', path]);
  const match = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(tree);
  if (!match) return tree ? unavailable : null;
  const [, oid] = match;
  const size = Number(await gitIn(root, ['cat-file', '-s', oid]));
  if (size > maxFile) return unavailable;
  const data = await gitIn(root, ['cat-file', 'blob', oid], { encoding: 'buffer', maxBuffer: maxFile + 1 });
  return fileVersion(data);
}

async function headsChanged(root, before, after) {
  if (before === after) return [];
  const args = before && after
    ? ['diff', '--relative', '--no-renames', '--no-ext-diff', '--name-only', '-z', before, after, '--', '.']
    : ['ls-tree', '-r', '--name-only', '-z', before ?? after, '--', '.'];
  return (await gitIn(root, args, { maxBuffer: 32_000_000 })).split('\0').filter(Boolean);
}

async function eachBatch(paths, get, consume) {
  for (let index = 0; index < paths.length; index += 8) {
    const batch = paths.slice(index, index + 8);
    const values = await Promise.all(batch.map(get));
    for (let offset = 0; offset < batch.length; offset++) consume(batch[offset], values[offset]);
  }
}

export async function startReview(root) {
  const prefix = await gitPrefix(root);
  if (prefix === null) return null;
  const [head, changes] = await Promise.all([gitHead(root), listChanges(root)]);
  const dirty = new Set(changes.map(item => item.path));
  const files = new Map();
  let bytes = 0;
  await eachBatch([...dirty].slice(0, maxPaths), path => currentFile(root, path), (path, version) => {
    bytes += Buffer.byteLength(version?.text ?? '');
    if (bytes <= maxBaseline) files.set(path, version);
  });
  return { head, dirty, files };
}

async function makePatch(scratch, before, after) {
  const left = join(scratch, 'before.txt');
  const right = join(scratch, 'after.txt');
  await Promise.all([writeFile(left, before), writeFile(right, after)]);
  const output = await gitIn(scratch, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--', left, right]).catch(error => {
    if (error.code === 1) return error.stdout;
    throw error;
  });
  const start = output.indexOf('\n@@ ');
  return start < 0 ? '' : output.slice(start + 1).replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/gm, '$1');
}

export async function finishReview(root, baseline) {
  if (!baseline) return unavailableGit;
  const [head, changes] = await Promise.all([gitHead(root), listChanges(root)]);
  const paths = [...new Set([...baseline.dirty, ...changes.map(item => item.path),
    ...await headsChanged(root, baseline.head, head)])].sort();
  const versions = new Map();
  let skipped = Math.max(0, paths.length - maxPaths);
  await eachBatch(paths.slice(0, maxPaths), async path => {
    const before = baseline.dirty.has(path)
      ? baseline.files.get(path) ?? (baseline.files.has(path) ? null : unavailable)
      : await headFile(root, baseline.head, path);
    const after = await currentFile(root, path);
    return { before, after };
  }, (path, value) => versions.set(path, value));

  let scratch;
  let bytes = 0;
  const files = [];
  try {
    for (const [path, { before, after }] of versions) {
      if (before === unavailable || after === unavailable) {
        skipped++;
        continue;
      }
      if (before?.text === after?.text && before?.digest === after?.digest && Boolean(before) === Boolean(after)) continue;
      const status = !before ? 'A' : !after ? 'D' : 'M';
      const binary = Boolean(before?.digest || after?.digest);
      let patch = '';
      if (!binary && (before?.text || after?.text)) {
        scratch ??= await mkdtemp(join(tmpdir(), 'alicecode-review-'));
        patch = await makePatch(scratch, before?.text ?? '', after?.text ?? '');
      }
      const size = Buffer.byteLength(patch);
      const limited = bytes + size > maxPatches;
      if (limited) skipped++;
      else bytes += size;
      files.push({ path, status, patch: limited ? '' : patch, binary, limited });
    }
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
  return { state: skipped ? 'partial' : 'ready', files, skipped };
}
