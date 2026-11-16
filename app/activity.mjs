import { isAbsolute, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const editKinds = new Set(['edit', 'delete', 'move']);

export function projectPath(root, target) {
  if (typeof target !== 'string' || !target.trim() || target.includes('\0')) return null;
  const path = relative(root, resolve(root, target));
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) return null;
  return path.split(sep).join('/');
}

export function nodeTestCounts(output) {
  const counts = {};
  for (const match of output.matchAll(/^(?:#|ℹ) (tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$/gm)) {
    counts[match[1]] = Number(match[2]);
  }
  if (['tests', 'pass', 'fail'].some(key => !Number.isSafeInteger(counts[key]))) return;
  return counts.pass + counts.fail <= counts.tests
    ? { total: counts.tests, passed: counts.pass, failed: counts.fail }
    : undefined;
}

export function mergeToolUpdate(previous, update, root) {
  const raw = update.rawOutput;
  const input = update.rawInput;
  const status = update.status ?? previous.status ?? 'pending';
  const command = typeof raw?.command === 'string' ? raw.command
    : typeof input?.command === 'string' ? input.command : previous.command;
  const kind = command ? 'execute' : update.kind ?? previous.kind;
  const content = update.content?.filter(item => item.type === 'content' && item.content?.type === 'text')
    .map(item => item.content.text).join('\n');
  const output = stripVTControlCharacters(content || raw?.output_for_prompt || previous.output || '');
  const tool = {
    ...previous, id: update.toolCallId, kind, status,
    title: update.title ?? previous.title ?? 'Инструмент',
    output: output.length > 16_000 ? output.slice(0, 8_000) + '\n…\n' + output.slice(-8_000) : output,
  };
  if (command) tool.command = command;
  if (editKinds.has(kind)) {
    const candidates = [
      ...(update.locations ?? []).map(item => item.path),
      ...(update.content ?? []).filter(item => item.type === 'diff').map(item => item.path),
      input?.filePath ?? input?.file_path ?? input?.path,
    ];
    tool.paths = [...new Set([...(previous.paths ?? []), ...candidates.map(path => projectPath(root, path)).filter(Boolean)])];
  }
  if (kind === 'execute' && ['completed', 'failed'].includes(status)) {
    const exitCode = Number.isInteger(raw?.exit_code) && raw.exit_code >= 0
      ? raw.exit_code : Number(/^exit:\s*(\d+)\b/.exec(output)?.[1]);
    if (Number.isSafeInteger(exitCode)) tool.exitCode = exitCode;
    if (raw?.signal === 'backgrounded') tool.background = true;
    else if (raw?.signal || raw?.timed_out) tool.interrupted = true;
    const tests = nodeTestCounts(output);
    if (tests) tool.tests = tests;
  }
  return tool;
}

export function describePermission(tool, cwd, knownCwd) {
  const input = tool.rawInput;
  if (tool.kind === 'execute' || typeof input?.command === 'string') {
    return {
      kind: 'command', title: 'Разрешить команду?',
      command: input?.command ?? tool.title,
      directory: input?.cwd ?? knownCwd ?? cwd,
      directoryLabel: input?.cwd || knownCwd ? 'Рабочая папка' : 'Папка проекта',
    };
  }

  const diffs = (tool.content ?? []).filter(item => item.type === 'diff');
  const path = input?.filePath ?? input?.file_path ?? input?.path ?? tool.locations?.[0]?.path;
  if (diffs.length || (path && (editKinds.has(tool.kind) || ['Write', 'SearchReplace'].includes(input?.variant)))) {
    return {
      kind: 'edit', title: 'Разрешить изменение файла?',
      changes: diffs.length ? diffs.map(item => ({ path: item.path, before: item.oldText, after: item.newText }))
        : [{ path, before: input?.old_string, after: input?.new_string ?? input?.content }],
    };
  }

  return {
    kind: 'other', title: 'Разрешить действие?', action: tool.title,
    detail: typeof input === 'object' && input !== null ? JSON.stringify(input, null, 2) : String(input ?? ''),
  };
}
