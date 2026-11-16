import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { alias, modelUri, startAdapter } from './app/adapter.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const folderId = process.env.YANDEX_FOLDER_ID;
const apiKey = process.env.YANDEX_API_KEY;
const agentEnv = { ...process.env };
for (const name of ['YANDEX_FOLDER_ID', 'YANDEX_API_KEY', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY']) {
  delete agentEnv[name];
}
const model = modelUri(folderId);
const prompt = [
  'Start by using the terminal tool to run node --test. Wait for its output before reading any files.',
  'Use the failing test output to diagnose the bug in this repository. Make one tool call at a time.',
  'Fix the underlying bug in the implementation and keep the tests unchanged.',
  'Run node --test again after the edit. Report the root cause, the change, and the observed test result.',
].join(' ');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: agentEnv, windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function git(args, cwd) {
  const result = run('git', args, cwd);
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git failed.');
  return result.stdout;
}

async function invokeGrok(repo, home, adapter, logPath) {
  const config = [
    '[cli]',
    'auto_update = false',
    '[telemetry]',
    'enabled = false',
    `[model.${alias}]`,
    `model = "${model}"`,
    `base_url = "${adapter.baseUrl}"`,
    'env_key = "ALICE_ADAPTER_TOKEN"',
    'api_backend = "chat_completions"',
    'temperature = 0',
    'context_window = 65536',
  ].join('\n');
  await writeFile(join(home, 'config.toml'), config + '\n');

  const child = spawn('grok', [
    '-m', alias, '--no-memory', '--no-plan', '--no-subagents', '--disable-web-search',
    '--tools', 'run_terminal_cmd,read_file,search_replace,list_dir,grep',
    '--permission-mode', 'dontAsk', '--allow', 'Bash(node --test)',
    '--allow', 'Edit(shipping.cjs)',
    '--output-format', 'streaming-json', '-p', prompt,
  ], {
    cwd: repo,
    env: {
      ...agentEnv,
      GROK_HOME: home,
      GROK_TELEMETRY_ENABLED: 'false',
      ALICE_ADAPTER_TOKEN: adapter.token,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const timer = setTimeout(() => child.kill(), 180_000);
  try {
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const [status] = await Promise.all([exited, pipeline(child.stdout, createWriteStream(logPath))]);
    return status;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId ?? '') || !apiKey?.trim()) {
    throw new Error('Set YANDEX_FOLDER_ID and YANDEX_API_KEY, or run run-alice.ps1 -Configure.');
  }
  const runs = join(root, '.alice-runs');
  await mkdir(runs, { recursive: true });
  const directory = await mkdtemp(join(runs, 'run-'));
  const repo = join(directory, 'repo');
  const home = join(directory, 'grok-home');
  await cp(join(root, 'fixture'), repo, { recursive: true });
  await mkdir(home);
  git(['init', '-q'], repo);
  git(['add', 'shipping.cjs', 'shipping.test.cjs'], repo);
  git(['-c', 'user.name=Alicecode fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Baseline with a failing test'], repo);

  const before = run('node', ['--test', '--test-reporter=tap'], repo);
  await writeFile(join(directory, 'tests-before.txt'), before.stdout + before.stderr);
  if (before.status !== 1 || !before.stdout.includes('# fail 1')) {
    throw new Error(`Expected one failing fixture test. See ${directory}.`);
  }
  console.log(`Baseline: one failing test. Run artifacts: ${directory}`);

  const adapter = await startAdapter({ folderId, apiKey, track: true });
  let grok;
  try {
    grok = await invokeGrok(repo, home, adapter, join(directory, 'agent.jsonl'));
  } finally {
    adapter.server.close();
    adapter.server.closeAllConnections();
  }
  const after = run('node', ['--test', '--test-reporter=tap'], repo);
  const changed = git(['status', '--porcelain', '--untracked-files=all'], repo).trim();
  const tools = [...adapter.tools.values()];
  const edit = tools.findIndex(tool => tool.name === 'search_replace');
  const testRuns = tools.flatMap((tool, index) => {
    if (tool.name !== 'run_terminal_command') return [];
    const exit = /^exit:\s*(\d+)/.exec(tool.output);
    return exit ? [{ index, exit: Number(exit[1]) }] : [];
  });
  const summary = {
    model: alias,
    grok,
    requests: adapter.requests,
    baselineExit: before.status,
    finalExit: after.status,
    agentRanTestsBeforeAndAfterEdit: edit !== -1
      && testRuns.some(test => test.index < edit && test.exit === 1)
      && testRuns.some(test => test.index > edit && test.exit === 0),
    onlyImplementationChanged: /^M\s+shipping\.cjs$/.test(changed),
  };
  await Promise.all([
    writeFile(join(directory, 'tests-after.txt'), after.stdout + after.stderr),
    writeFile(join(directory, 'fix.diff'), git(['diff', 'HEAD', '--'], repo)),
    writeFile(join(directory, 'tools.json'), JSON.stringify(tools, null, 2) + '\n'),
    writeFile(join(directory, 'result.json'), JSON.stringify(summary, null, 2) + '\n'),
  ]);
  console.log(JSON.stringify(summary, null, 2));
  if (grok.code !== 0 || after.status !== 0 || !summary.onlyImplementationChanged
    || !summary.agentRanTestsBeforeAndAfterEdit
    || !adapter.requests.some(request => !request.title && request.status === 200)) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
