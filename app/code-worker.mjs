import { parentPort, workerData } from 'node:worker_threads';
import { realpathSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { gitIn } from './workspace.mjs';

const require = createRequire(import.meta.url), libRoot = realpathSync(workerData.libRoot ?? dirname(require.resolve('typescript')));
const { action, input } = workerData;
const sourcePattern = /\.(?:[cm]?[jt]sx?|json)$/i;
const hash = text => createHash('sha256').update(text).digest('hex');
const inside = (root, file) => { const path = relative(root, file); return !isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'); };
try {
  const root = realpathSync(workerData.root), overlays = new Map(); let bytes = 0, limited = false;
  for (const item of (input.overlays ?? []).slice(0, 40)) {
    if (typeof item.text !== 'string' || item.text.length > 512000) throw new Error('Слишком большой буфер редактора.');
    const file = realpathSync(resolve(root, item.path)); if (!inside(root, file)) throw new Error('Буфер находится вне проекта.');
    overlays.set(file, item.text);
  }
  const permitted = file => {
    try { const full = realpathSync(file); return inside(root, full) || inside(libRoot, full); } catch { return false; }
  };
  const reads = new Map();
  const read = file => {
    if (!permitted(file)) return undefined;
    const full = realpathSync(file); if (overlays.has(full)) return overlays.get(full);
    if (reads.has(full)) return reads.get(full);
    try {
      const size = statSync(full).size; if (size > (/\.d\.[cm]?ts$/i.test(full) ? 4_000_000 : 1_000_000) || bytes + size > 32_000_000) { limited = true; return undefined; }
      const text = readFileSync(full, 'utf8'); bytes += size; reads.set(full, text); return text;
    } catch { return undefined; }
  };
  let paths;
  try { paths = (await gitIn(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { maxBuffer: 8_000_000 })).split('\0').filter(Boolean); }
  catch {
    paths = [];
    const walk = directory => { for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (paths.length >= 3000) { limited = true; return; }
      if (['node_modules', '.git', 'dist', 'build', '.venv'].includes(item.name) || item.isSymbolicLink()) continue;
      const file = join(directory, item.name); if (item.isDirectory()) walk(file); else if (sourcePattern.test(file)) paths.push(relative(root, file));
    } }; walk(root);
  }
  const roots = paths.filter(path => sourcePattern.test(path) && !path.split(/[\\/]/).some(part => ['node_modules', '.git', 'dist', 'build'].includes(part)))
    .map(path => resolve(root, path)).filter(file => permitted(file));
  const configPath = workerData.config && join(root,workerData.config);
  let note = '', errors = [], options = { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true };
  let files = roots.filter(file => /\.[cm]?[jt]sx?$/i.test(file));
  if (configPath) {
    const config = ts.readConfigFile(configPath, read);
    if (config.error) errors.push(config.error);
    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, { ...ts.sys, readFile: read,
      fileExists: file => permitted(file) && ts.sys.fileExists(file),
      readDirectory: (dir, ...args) => permitted(dir) ? ts.sys.readDirectory(dir, ...args).filter(permitted) : [] }, dirname(configPath), undefined, configPath);
    options = { ...parsed.options, noEmit: true }; errors.push(...parsed.errors);
    if (parsed.projectReferences?.length) { limited = true; note = 'Конфигурация использует project references. Для полного анализа откройте папку соответствующего пакета.'; }
    const visible = new Set(files.map(file => realpathSync(file)));
    files = parsed.fileNames.filter(permitted).map(file => realpathSync(file)).filter(file => visible.has(file));
  } else files = files.filter(file => inside(resolve(root,workerData.directory),file));
  if (files.length > 3000) { limited = true; files = files.slice(0,3000); }
  if (input.path) {
    const selected = realpathSync(resolve(root, input.path));
    if (!inside(root, selected) || !/\.[cm]?[jt]sx?$/i.test(selected)) throw new Error('Навигация доступна для JS/TS-файлов проекта.');
    if (!files.includes(selected)) files.push(selected);
    if (/\.[cm]?jsx?$/i.test(selected) && action !== 'diagnostics') options = { ...options, allowJs: true };
  }
  const host = { getScriptFileNames: () => files, getScriptVersion: file => hash(read(file) ?? ''),
    getScriptSnapshot: file => { const text = read(file); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => root, getCompilationSettings: () => options, getDefaultLibFileName: settings => join(libRoot, basename(ts.getDefaultLibFilePath(settings))), getDefaultLibLocation: () => libRoot,
    fileExists: file => permitted(file) && ts.sys.fileExists(file), readFile: read,
    directoryExists: path => permitted(path) && ts.sys.directoryExists(path), getDirectories: path => permitted(path) ? ts.sys.getDirectories(path) : [],
    readDirectory: (path, ...args) => permitted(path) ? ts.sys.readDirectory(path, ...args).filter(permitted) : [],
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames, getNewLine: () => '\n', realpath: file => permitted(file) ? realpathSync(file) : file };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const location = (file, start = 0, length = 0) => {
    if (!permitted(file)) return null; const full = realpathSync(file); if (!inside(root, full)) return null;
    const source = service.getProgram()?.getSourceFile(file) ?? ts.createSourceFile(file, read(file) ?? '', ts.ScriptTarget.Latest);
    const point = source.getLineAndCharacterOfPosition(Math.min(start, source.text.length));
    return { path: relative(root, full).replaceAll('\\', '/'), line: point.line + 1, column: point.character + 1, start, length };
  };
  let result;
  if (action === 'diagnostics') {
    const program = service.getProgram();
    const sources = program.getSourceFiles().filter(source => inside(root,source.fileName) && !source.fileName.split(/[\\/]/).includes('node_modules'));
    if (sources.length > 3000) limited = true;
    const diagnostics = [...errors, ...service.getCompilerOptionsDiagnostics(), ...sources.slice(0,3000).flatMap(source =>
      [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)])];
    const seen = new Set(); const problems = [];
    for (const diagnostic of diagnostics) {
      const place = diagnostic.file ? location(diagnostic.file.fileName, diagnostic.start, diagnostic.length) : {};
      if (!place) continue;
      const problem = { ...place, code: 'TS' + diagnostic.code, severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), source: 'TypeScript' };
      const key = JSON.stringify(problem); if (!seen.has(key)) { seen.add(key); problems.push(problem); }
      if (problems.length >= 500) { limited = true; break; }
    }
    result = { problems, fingerprint: hash(JSON.stringify(files.map(file => [file, read(file)]))), files: files.length, version: ts.version };
  } else {
    const file = realpathSync(resolve(root, input.path)), text = read(file) ?? '', position = Math.max(0, Math.min(text.length, Number(input.position) || 0));
    if (action === 'definition' || action === 'references') {
      const entries = action === 'definition' ? service.getDefinitionAtPosition(file, position) : service.getReferencesAtPosition(file, position);
      result = { items: (entries ?? []).map(item => ({ ...location(item.fileName, item.textSpan.start, item.textSpan.length), name: item.name ?? 'Использование' })).filter(item => item.path).slice(0, 300) };
    } else if (action === 'symbols') {
      const items = [];
      const walk = (nodes, level = 0) => { for (const node of nodes ?? []) { const place = location(file, node.spans?.[0]?.start ?? 0); if (place && node.kind !== 'script') items.push({ ...place, name: node.text, kind: node.kind, level }); walk(node.childItems, level + 1); } };
      walk(service.getNavigationBarItems(file)); result = { items: items.slice(0, 500) };
    } else throw new Error('Неизвестное действие анализа.');
  }
  service.dispose();
  parentPort.postMessage({ ...result, config: workerData.config, limited, note });
} catch (error) { parentPort.postMessage({ error: error.message }); }
