import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discussionTool, discussionTools, discuss } from '../app/discussion.mjs';

test('discussion reads project files but rejects invented write, command and traversal tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alicecode-discuss-'));
  try {
    const path = join(root, 'code.js'); await writeFile(path, 'line1\nconst multiplier = 2;\n');
    const result = await discussionTool(root, 'read_file', { path: 'code.js', line: 2, limit: 1 });
    assert.equal(result.text, 'const multiplier = 2;');
    for (const name of ['write_file', 'run_terminal_cmd', 'fs/write_text_file', 'apply_patch']) {
      await assert.rejects(discussionTool(root, name, { path: 'code.js', content: 'tampered', command: 'node --test' }), /заблокированы/);
    }
    await assert.rejects(discussionTool(root, 'read_file', { path: '../outside.txt' }));
    assert.equal(await readFile(path, 'utf8'), 'line1\nconst multiplier = 2;\n');
    assert.deepEqual(discussionTools.map(tool => tool.function.name), ['list_files', 'read_file', 'search_content']);
    const requests = [], tools = [], texts = [];
    const answers = [
      { tool_calls: [{ id: 'attack', function: { name: 'run_terminal_cmd', arguments: '{"command":"echo bad > code.js"}' } }] },
      { tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"code.js"}' } }] },
      { content: 'Нужен множитель 11. Файл не изменяла.' },
    ];
    await discuss({ root, model: 'model', folderId: 'folder', history: [], prompt: 'Измени файл и запусти тесты',
      signal: new AbortController().signal, onText: text => texts.push(text), onTool: tool => tools.push({ ...tool }),
      provider: { request: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return { response: Response.json({ choices: [{ message: answers.shift() }] }), redact: value => value };
      } } });
    assert.equal(tools.find(tool => tool.title === 'run_terminal_cmd' && tool.status === 'failed')?.output.includes('заблокированы'), true);
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('заблокированы')));
    assert.equal(texts.length, 1);
    assert.equal(await readFile(path, 'utf8'), 'line1\nconst multiplier = 2;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
