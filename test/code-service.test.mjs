import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codeQuery } from '../app/code-service.mjs';

test('JS/TS navigation resolves cross-file symbols and type diagnostics respect unsaved buffers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-language-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [] }, include: ['src/**/*.ts'] }));
    const domain = 'export function factor(region: string): number { return region === "ridge" ? "11" : 2; }\n';
    const quote = 'import { factor } from "./domain";\nexport function quote(weight: number) { return weight * factor("ridge"); }\n';
    await writeFile(join(root, 'src', 'domain.ts'), domain); await writeFile(join(root, 'src', 'quote.ts'), quote);
    const definitions = await codeQuery(root, 'definition', { path: 'src/quote.ts', position: quote.lastIndexOf('factor') + 2 });
    assert.equal(definitions.items[0].path, 'src/domain.ts');
    const refs = await codeQuery(root, 'references', { path: 'src/domain.ts', position: domain.indexOf('factor') + 2 });
    assert.ok(refs.items.some(item => item.path === 'src/quote.ts'));
    const symbols = await codeQuery(root, 'symbols', { path: 'src/domain.ts' }); assert.ok(symbols.items.some(item => item.name === 'factor'));
    const errors = await codeQuery(root, 'diagnostics'); assert.ok(errors.problems.some(item => item.code === 'TS2322'));
    const fixed = await codeQuery(root, 'diagnostics', { overlays: [{ path: 'src/domain.ts', text: domain.replace('"11"', '11') }] });
    assert.equal(fixed.problems.filter(item => item.severity === 'error').length, 0);
    assert.notEqual(errors.fingerprint, fixed.fingerprint);
    await writeFile(join(root, 'src', 'helper.cjs'), 'function add(value) { return value + 1; }\nmodule.exports = { add };\n');
    const js = 'const { add } = require("./helper.cjs");\nconsole.log(add(1));\n'; await writeFile(join(root, 'src', 'consumer.cjs'), js);
    const jsDefinition = await codeQuery(root, 'definition', { path: 'src/consumer.cjs', position: js.lastIndexOf('add') + 1 });
    assert.equal(jsDefinition.items[0]?.path, 'src/helper.cjs');
    await assert.rejects(codeQuery(root, 'definition', { path: '../outside.ts', position: 0 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
