#!/usr/bin/env node
// Provider-backed agent loop eval: runs scripted objectives against a real
// model with sandboxed tmp-dir tools and asserts the loop converges. Use it
// to learn which saved models are agent-capable. Follows the same provider
// argument conventions as scripts/memory-eval.mjs.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const coreDist = path.join(repoRoot, 'packages/core/dist/index.js');

if (!fs.existsSync(coreDist)) {
  process.stderr.write(`Core build not found: ${coreDist}\n`);
  process.stderr.write('Run pnpm build before running scripts/agent-eval.mjs.\n');
  process.exit(1);
}

const { MarifoldRuntime } = require(coreDist);

if (process.argv.slice(2).includes('--help')) {
  printHelp();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const provider = args.provider ?? 'ollama';
const providerType = args.providerType ?? (provider === 'anthropic' ? 'anthropic' : provider === 'ollama' ? 'ollama' : 'openai-compatible');
const model = args.model ?? 'gemma4:e4b';
const toolMode = args.toolMode ?? 'auto';
const keep = Boolean(args.keep);
const root = args.workdir ? path.resolve(expandHome(args.workdir)) : fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-agent-eval-'));
const profilesDir = path.join(root, 'profiles');
const workspaceDir = path.join(root, 'workspace');
const configPath = path.join(root, 'config.toml');

const cases = [
  {
    name: 'read-and-answer',
    setup: dir => fs.writeFileSync(path.join(dir, 'fact.txt'), 'The launch code word is MARIGOLD.\n'),
    objective: 'Read the file fact.txt and report the launch code word it contains.',
    check: ({ events, finalSummary }) => {
      const usedTool = events.some(e => e.type === 'tool_result' && !e.isError);
      const mentioned = /marigold/i.test(finalSummary ?? '');
      if (!usedTool) return 'expected at least one successful tool call';
      if (!mentioned) return `expected the summary to mention MARIGOLD, got: ${finalSummary}`;
      return undefined;
    },
  },
  {
    name: 'write-file',
    setup: () => {},
    objective: 'Create a file named greeting.txt containing exactly the text "hello agent".',
    check: ({ dir }) => {
      const target = path.join(dir, 'greeting.txt');
      if (!fs.existsSync(target)) return 'greeting.txt was not created';
      const content = fs.readFileSync(target, 'utf-8').trim();
      if (!/hello agent/i.test(content)) return `unexpected content: ${content}`;
      return undefined;
    },
  },
  {
    name: 'shell-count',
    setup: dir => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
    },
    objective: 'Count how many .txt files exist in the current directory and state the number.',
    check: ({ finalSummary }) => (/\b3\b|three/i.test(finalSummary ?? '') ? undefined : `expected the answer 3, got: ${finalSummary}`),
  },
];

try {
  fs.mkdirSync(profilesDir, { recursive: true });
  writeProfile(profilesDir, provider, model);
  fs.writeFileSync(configPath, renderConfig());

  process.env.MARIFOLD_CONFIG = configPath;
  const { ConfigLoader } = require(coreDist);
  const loadedConfig = new ConfigLoader().load({ configPath });
  const runtime = new MarifoldRuntime({ loadedConfig });

  let failures = 0;
  try {
    for (const testCase of cases) {
      const dir = path.join(workspaceDir, testCase.name);
      fs.mkdirSync(dir, { recursive: true });
      testCase.setup(dir);

      const events = [];
      let finalSummary;
      let status;
      const runner = runtime.createAgentRunner();
      for await (const event of runner.run({
        objective: testCase.objective,
        cwd: dir,
        toolMode,
        maxIterations: numberArg(args.maxIterations, 8),
        // Eval runs are sandboxed in tmp dirs: approve everything.
        approvalHandler: async () => ({ approved: true }),
      })) {
        events.push(event);
        if (event.type === 'done') {
          finalSummary = event.summary;
          status = event.status;
        }
      }

      const problem = status === 'failed'
        ? `run ended with status failed`
        : testCase.check({ dir, events, finalSummary, status });
      if (problem) {
        failures += 1;
        process.stdout.write(`FAIL ${testCase.name}: ${problem}\n`);
      } else {
        process.stdout.write(`PASS ${testCase.name} (${status})\n`);
      }
    }
  } finally {
    runtime.close();
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures}/${cases.length} agent eval cases failed for ${provider}/${model}.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nAll ${cases.length} agent eval cases passed for ${provider}/${model}.\n`);
  }
} finally {
  if (keep) {
    process.stdout.write(`Workspace kept at ${root}\n`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeProfile(root, providerName, modelName) {
  const profileDir = path.join(root, 'default');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'PROFILE.md'), '# Agent Eval\n\nYou are a focused agent completing small filesystem tasks.\n');
  fs.writeFileSync(path.join(profileDir, 'RULES.md'), '# Rules\n\n- Use tools when needed.\n- Keep answers short.\n');
  fs.writeFileSync(path.join(profileDir, 'profile.toml'), `memories = false\nprovider = "${providerName}"\nmodel = "${modelName}"\n`);
}

function renderConfig() {
  const lines = [
    '[default]',
    `provider = "${provider}"`,
    `model = "${model}"`,
    'profile = "default"',
    `timeout_seconds = ${numberArg(args.timeout, 120)}`,
    'think = false',
    '',
    '[paths]',
    `profiles_dir = "${profilesDir}"`,
    `sessions_db = "${path.join(root, 'sessions.db')}"`,
    `tasks_dir = "${path.join(root, 'tasks')}"`,
    '',
    `[providers.${provider}]`,
    `type = "${providerType}"`,
  ];
  if (args.baseUrl) lines.push(`base_url = "${args.baseUrl.replace(/\/+$/, '')}"`);
  else if (providerType === 'ollama') lines.push('base_url = "http://localhost:11434"');
  else if (provider === 'openai') lines.push('base_url = "https://api.openai.com"');
  if (args.apiKeyEnv) lines.push(`api_key_env = "${args.apiKeyEnv}"`);
  if (args.apiKey) lines.push(`api_key = "${args.apiKey}"`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = toCamel(arg.slice(2));
    if (key === 'keep') {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function numberArg(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected a number, got ${value}`);
  return number;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function printHelp() {
  process.stdout.write(`Marifold agent eval

Runs scripted agent objectives against a real provider with sandboxed
tmp-dir tools and reports which cases converge. Build first: pnpm build.

Usage:
  node scripts/agent-eval.mjs -- --provider ollama --model gemma4:e4b
  node scripts/agent-eval.mjs -- --provider ollama --model qwen3:8b --tool-mode control-block

Options:
  --provider <name>        Provider key (default: ollama)
  --provider-type <type>   ollama | openai-compatible | anthropic
  --model <model>          Model name (default: gemma4:e4b)
  --tool-mode <mode>       auto | native | control-block (default: auto)
  --max-iterations <n>     Model turns per case (default: 8)
  --timeout <seconds>      Provider timeout (default: 120)
  --base-url <url>         Provider base URL
  --api-key-env <name>     Environment variable holding the API key
  --api-key <key>          Inline API key (avoid in shell history)
  --workdir <dir>          Use a fixed working directory
  --keep                   Keep the working directory after the run
`);
}
