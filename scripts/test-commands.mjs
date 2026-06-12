#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const cliPath = process.env.MARIFOLD_COMMAND_TEST_CLI
  ? path.resolve(process.env.MARIFOLD_COMMAND_TEST_CLI)
  : path.join(repoRoot, 'packages/cli/dist/index.js');
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));

const args = new Set(process.argv.slice(2));
const keepTemp = args.has('--keep-temp');
const verbose = args.has('--verbose');

if (!fs.existsSync(cliPath)) {
  process.stderr.write(`CLI build not found: ${cliPath}\n`);
  process.stderr.write('Run pnpm build before pnpm command-test.\n');
  process.exit(1);
}

let checkCount = 0;
let tempRoot = '';
let mockServer;

try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-command-test-'));
  const configPath = path.join(tempRoot, 'config.toml');
  const profilesDir = path.join(tempRoot, 'profiles');
  const sessionsDb = path.join(tempRoot, 'sessions', 'sessions.db');
  const tasksDir = path.join(tempRoot, 'tasks');
  const schedulesDir = path.join(tempRoot, 'schedules');
  const backupPath = path.join(tempRoot, 'backup.json');
  const tempHome = path.join(tempRoot, 'home');
  fs.mkdirSync(tempHome, { recursive: true });

  mockServer = await startMockProviderServer();
  const mockBaseUrl = `http://127.0.0.1:${mockServer.port}`;
  const configArgs = ['--config', configPath];
  const commandEnv = {
    HOME: tempHome,
    NO_COLOR: '1',
    MARIFOLD_COMMAND_TEST_KEY: 'test-command-key',
  };

  runCase('root --version', ['--version'], {
    env: commandEnv,
    contains: rootPackage.version,
  });
  runHelpDiscovery(commandEnv);

  runCase('init with every init option', [
    ...configArgs,
    'init',
    '--force',
    '--provider', 'ollama',
    '--provider-type', 'ollama',
    '--model', 'gemma4:e4b',
    '--profile', 'default',
    '--profiles-dir', profilesDir,
    '--sessions-db', sessionsDb,
    '--tasks-dir', tasksDir,
    '--schedules-dir', schedulesDir,
    '--base-url', mockBaseUrl,
    '--api-key-env', 'MARIFOLD_COMMAND_TEST_KEY',
  ], {
    env: commandEnv,
    contains: ['Initialized Marifold', 'Provider: ollama/gemma4:e4b (ollama)'],
  });

  runCase('config show', [...configArgs, 'config', 'show'], {
    env: commandEnv,
    contains: ['[default]', '[providers.ollama]'],
  });
  runConfigSetMatrix(configArgs, commandEnv, profilesDir, sessionsDb, tasksDir, mockBaseUrl);

  runCase('profile root', [...configArgs, 'profile'], {
    env: commandEnv,
    contains: 'Current profile:',
  });
  runCase('profile init [name]', [...configArgs, 'profile', 'init', 'alt'], {
    env: commandEnv,
    contains: "Created profile 'alt'",
  });
  runCase('profile list', [...configArgs, 'profile', 'list'], {
    env: commandEnv,
    contains: ['default', 'alt'],
  });
  runCase('profile show [name]', [...configArgs, 'profile', 'show', 'alt'], {
    env: commandEnv,
    contains: ['Profile: alt', 'Memory:'],
  });
  runCase('profile default [name]', [...configArgs, 'profile', 'default', 'alt'], {
    env: commandEnv,
    contains: "Default profile set to 'alt'.",
  });
  runCase('profile default', [...configArgs, 'profile', 'default'], {
    env: commandEnv,
    contains: 'Current profile: alt',
  });
  runCase('profile init delete target', [...configArgs, 'profile', 'init', 'delete-me'], {
    env: commandEnv,
    contains: "Created profile 'delete-me'",
  });
  runCase('profile rename <from> <to>', [...configArgs, 'profile', 'rename', 'delete-me', 'delete-renamed'], {
    env: commandEnv,
    contains: "Renamed profile 'delete-me' to 'delete-renamed'.",
  });
  runCase('profile delete <name> --yes', [...configArgs, 'profile', 'delete', 'delete-renamed', '--yes'], {
    env: commandEnv,
    contains: "Deleted profile 'delete-renamed'",
  });

  runCase('model root', [...configArgs, 'model'], {
    env: commandEnv,
    contains: 'Current model:',
  });
  runCase('model list', [...configArgs, 'model', 'list'], {
    env: commandEnv,
    contains: 'ollama/gemma4:e4b',
  });
  runCase('model add with every add option', [
    ...configArgs,
    'model', 'add',
    'openai',
    'gpt-test',
    '--provider-type', 'openai-compatible',
    '--base-url', mockBaseUrl,
    '--api-key-env', 'MARIFOLD_COMMAND_TEST_KEY',
    '--default',
  ], {
    env: commandEnv,
    contains: ['Added openai/gpt-test', 'Set default model to openai/gpt-test'],
  });
  runCase('model validate [model] --provider --profile', [
    ...configArgs,
    'model', 'validate',
    'gpt-test',
    '--provider', 'openai',
    '--profile', 'alt',
  ], {
    env: commandEnv,
    contains: 'OK openai/gpt-test: Model is available.',
  });
  runCase('model default [model] --provider --profile', [
    ...configArgs,
    'model', 'default',
    'qwen3:8b',
    '--provider', 'ollama',
    '--profile', 'alt',
  ], {
    env: commandEnv,
    contains: "Set profile 'alt' model to ollama/qwen3:8b.",
  });
  runCase('model default --profile --clear', [
    ...configArgs,
    'model', 'default',
    '--profile', 'alt',
    '--clear',
  ], {
    env: commandEnv,
    contains: "Cleared model override for profile 'alt'.",
  });
  runCase('model default [provider/model]', [
    ...configArgs,
    'model', 'default',
    'ollama/gemma4:e4b',
  ], {
    env: commandEnv,
    contains: 'Set ollama/gemma4:e4b',
  });
  runCase('model validate default', [...configArgs, 'model', 'validate'], {
    env: commandEnv,
    contains: 'OK ollama/gemma4:e4b: Model is available.',
  });
  runCase('model validate --all', [...configArgs, 'model', 'validate', '--all'], {
    env: commandEnv,
    contains: ['OK ollama/gemma4:e4b', 'OK openai/gpt-test'],
  });
  runCase('model rm <provider/model>', [...configArgs, 'model', 'rm', 'openai/gpt-test'], {
    env: commandEnv,
    contains: 'Removed openai/gpt-test',
  });

  runCase('provider root', [...configArgs, 'provider'], {
    env: commandEnv,
    contains: 'Current provider: ollama',
  });
  runCase('provider list command', [...configArgs, 'provider', 'list'], {
    env: commandEnv,
    contains: ['ollama', 'openai'],
  });
  runCase('provider status', [...configArgs, 'provider', 'status'], {
    env: commandEnv,
    contains: ['Provider\tConfigured', 'ollama'],
  });
  runCase('provider [name] [action=list]', [...configArgs, 'provider', 'ollama', 'list'], {
    env: commandEnv,
    contains: ['gemma4:e4b', 'qwen3:8b'],
  });

  runCase('ask with every ask option', [
    ...configArgs,
    'ask',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
    '--session', 'ask-session',
    '--no-memories',
    '--think', 'false',
    'hello',
    'from',
    'ask',
  ], {
    env: commandEnv,
    contains: 'mock response',
  });

  runCase('agent --help', [...configArgs, 'agent', '--help'], {
    env: commandEnv,
    contains: ['approval-aware', '--tool-mode', '--max-iterations', '--yes'],
  });

  const scheduleCreate = runCase('schedule add', [
    ...configArgs,
    'schedule', 'add',
    '--cron', '0 9 * * 1-5',
    '--name', 'weekday-digest',
    'Summarize my notes.',
  ], {
    env: commandEnv,
    contains: 'Created schedule sched_',
    capture: true,
  });
  const scheduleId = /Created schedule (sched_[a-f0-9]+)/.exec(scheduleCreate.stdout)?.[1];
  if (!scheduleId) throw new Error('schedule add did not print a schedule id');
  runCase('schedule list', [...configArgs, 'schedule', 'list'], {
    env: commandEnv,
    contains: ['weekday-digest', scheduleId],
  });
  runCase('schedule show <id>', [...configArgs, 'schedule', 'show', scheduleId], {
    env: commandEnv,
    contains: ['Summarize my notes.', '0 9 * * 1-5'],
  });
  runCase('schedule disable <id>', [...configArgs, 'schedule', 'disable', scheduleId], {
    env: commandEnv,
    contains: `Disabled schedule ${scheduleId}`,
  });
  runCase('schedule enable <id>', [...configArgs, 'schedule', 'enable', scheduleId], {
    env: commandEnv,
    contains: `Enabled schedule ${scheduleId}`,
  });
  runCase('schedule rm <id>', [...configArgs, 'schedule', 'rm', scheduleId], {
    env: commandEnv,
    contains: `Deleted schedule ${scheduleId}`,
  });

  runCase('config export <file> --include-sessions', [
    ...configArgs,
    'config', 'export',
    backupPath,
    '--include-sessions',
  ], {
    env: commandEnv,
    contains: ['Exported config backup', 'Sessions: included'],
  });
  runCase('config import <file> --force', [
    ...configArgs,
    'config', 'import',
    backupPath,
    '--force',
  ], {
    env: commandEnv,
    contains: ['Imported config backup', 'Sessions: restored'],
  });

  runCase('session list --limit --profile', [
    ...configArgs,
    'session', 'list',
    '--limit', '5',
    '--profile', 'default',
  ], {
    env: commandEnv,
    contains: ['ask-session', 'default'],
  });
  runCase('session show <id>', [...configArgs, 'session', 'show', 'ask-session'], {
    env: commandEnv,
    contains: ['Session: ask-session', 'hello from ask'],
  });
  runCase('session rename <from> <to>', [...configArgs, 'session', 'rename', 'ask-session', 'renamed-session'], {
    env: commandEnv,
    contains: 'Renamed session ask-session to renamed-session',
  });
  runCase('session show renamed', [...configArgs, 'session', 'show', 'renamed-session'], {
    env: commandEnv,
    contains: 'Session: renamed-session',
  });
  runCase('session delete <id>', [...configArgs, 'session', 'delete', 'renamed-session'], {
    env: commandEnv,
    contains: 'Deleted session renamed-session',
  });

  runCase('chat /help command', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
    '--no-memories',
  ], {
    env: commandEnv,
    input: '/help\n',
    contains: ['Chat commands:', '/remember pref <text>'],
  });

  runCase('chat /think command', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
    '--no-memories',
    '--think', 'true',
  ], {
    env: commandEnv,
    input: '/think off\n',
    contains: ['Think:    on', 'Thinking mode off.'],
  });

  runCase('chat /remember command', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
    '--session', 'chat-memory-session',
  ], {
    env: commandEnv,
    input: '/remember pref concise answers\n',
    contains: 'Remembered preference memory:',
  });

  runCase('profile memory [name]', [...configArgs, 'profile', 'memory', 'default'], {
    env: commandEnv,
    contains: ['Profile: default', 'concise answers', 'priority=2'],
  });

  runCase('chat /forget command', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
  ], {
    env: commandEnv,
    input: '/forget concise\n',
    contains: 'Forgot 1 memory record.',
  });

  runCase('chat /delete-memory command', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
  ], {
    env: commandEnv,
    input: '/delete-memory concise\n',
    contains: 'Deleted 1 memory record.',
  });

  runCase('chat with profile/provider/model/session/no-memories/think', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--provider', 'ollama',
    '--model', 'gemma4:e4b',
    '--session', 'chat-session',
    '--no-memories',
    '--think', 'true',
  ], {
    env: commandEnv,
    input: 'hello from chat\n',
    contains: ['Model:    ollama/gemma4:e4b', 'Memory:   off', 'Think:    on', 'mock response'],
  });

  runCase('chat --resume last --think', [
    ...configArgs,
    'chat',
    '--profile', 'default',
    '--resume', 'last',
    '--no-memories',
    '--think',
  ], {
    env: commandEnv,
    input: '/quit\n',
    contains: ['Session:  chat-session', 'Think:    on'],
  });

  runCase('session delete chat session', [...configArgs, 'session', 'delete', 'chat-session'], {
    env: commandEnv,
    contains: 'Deleted session chat-session',
  });

  runCase('profile init clear target', [...configArgs, 'profile', 'init', 'clear-target'], {
    env: commandEnv,
    contains: "Created profile 'clear-target'",
  });
  runCase('ask clear session one', [
    ...configArgs,
    'ask',
    '--profile', 'clear-target',
    '--session', 'clear-one',
    'hello',
    'clear',
    'one',
  ], {
    env: commandEnv,
    contains: 'mock response',
  });
  runCase('ask clear session two', [
    ...configArgs,
    'ask',
    '--profile', 'clear-target',
    '--session', 'clear-two',
    'hello',
    'clear',
    'two',
  ], {
    env: commandEnv,
    contains: 'mock response',
  });
  runCase('session clear --profile --keep-last --yes', [
    ...configArgs,
    'session', 'clear',
    '--profile', 'clear-target',
    '--keep-last', '1',
    '--yes',
  ], {
    env: commandEnv,
    contains: 'Cleared 1 session(s).',
  });
  runCase('session clear --profile --yes', [
    ...configArgs,
    'session', 'clear',
    '--profile', 'clear-target',
    '--yes',
  ], {
    env: commandEnv,
    contains: 'Cleared 1 session(s).',
  });

  process.stdout.write(`\nPASS ${checkCount} command checks\n`);
  if (keepTemp) process.stdout.write(`Kept temp workspace: ${tempRoot}\n`);
} catch (error) {
  process.stderr.write(`\nFAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  if (tempRoot) process.stderr.write(`Temp workspace: ${tempRoot}\n`);
  process.exitCode = 1;
} finally {
  if (mockServer) await new Promise(resolve => mockServer.server.close(resolve));
  if (tempRoot && !keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
}

function runConfigSetMatrix(configArgs, env, profilesDir, sessionsDb, tasksDir, mockBaseUrl) {
  const cases = [
    ['default.timeout_seconds', '30'],
    ['default.max_output_tokens', '64'],
    ['default.max_system_chars', '12000'],
    ['default.think', 'false'],
    ['memory.size_limit', '50000'],
    ['memory.context_limit', '2400'],
    ['paths.profiles_dir', profilesDir],
    ['paths.sessions_db', sessionsDb],
    ['paths.tasks_dir', tasksDir],
    ['paths.schedules_dir', path.join(path.dirname(tasksDir), 'schedules')],
    ['providers.ollama.type', 'ollama'],
    ['providers.ollama.base_url', mockBaseUrl],
    ['providers.ollama.api_key_env', 'MARIFOLD_COMMAND_TEST_KEY'],
    ['providers.openai.type', 'openai-compatible'],
    ['providers.openai.base_url', mockBaseUrl],
    ['providers.openai.api_key_env', 'MARIFOLD_COMMAND_TEST_KEY'],
    ['providers.openai.api_key', 'test-api-key'],
    ['providers.openai.oauth_token', 'test-oauth-token'],
    ['providers.openai.api_key_expires_at', '1893456000'],
  ];

  for (const [key, value] of cases) {
    runCase(`config set ${key}`, [...configArgs, 'config', 'set', key, value], {
      env,
      contains: `Set ${key} = ${value}`,
    });
  }
}

function runHelpDiscovery(env) {
  const queue = [[]];
  const seen = new Set();

  while (queue.length > 0) {
    const commandPath = queue.shift();
    const key = commandPath.join(' ') || '<root>';
    if (seen.has(key)) continue;
    seen.add(key);

    const helpArgs = [...commandPath, '--help'];
    const result = runCase(`help ${key}`, helpArgs, {
      env,
      contains: 'Usage:',
      capture: true,
    });

    for (const child of parseSubcommands(result.stdout)) {
      queue.push([...commandPath, child]);
    }
  }
}

function parseSubcommands(helpText) {
  const commands = [];
  let inCommands = false;

  for (const line of helpText.split(/\r?\n/)) {
    if (line.startsWith('Commands:')) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!line.trim()) break;
    const match = line.match(/^  (\S+)/);
    if (!match) continue;
    const command = match[1].split('|')[0];
    if (command === 'help') continue;
    commands.push(command);
  }

  return commands;
}

function runCase(name, cliArgs, options = {}) {
  const expectedStatuses = Array.isArray(options.status)
    ? options.status
    : [options.status ?? 0];
  const env = {
    ...process.env,
    ...options.env,
    FORCE_COLOR: '0',
  };
  const result = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: repoRoot,
    env,
    input: options.input,
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? 10000,
    maxBuffer: 1024 * 1024 * 4,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = `${stdout}${stderr}`;
  if (result.error) {
    throw new Error(`${name}: ${result.error.message}`);
  }
  if (!expectedStatuses.includes(result.status ?? 0)) {
    throw new Error([
      `${name}: expected status ${expectedStatuses.join(' or ')}, got ${result.status}`,
      `command: node ${path.relative(repoRoot, cliPath)} ${cliArgs.join(' ')}`,
      `stdout:\n${stdout}`,
      `stderr:\n${stderr}`,
    ].join('\n'));
  }

  for (const needle of asArray(options.contains)) {
    if (!combined.includes(needle)) {
      throw new Error([
        `${name}: expected output to contain ${JSON.stringify(needle)}`,
        `command: node ${path.relative(repoRoot, cliPath)} ${cliArgs.join(' ')}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join('\n'));
    }
  }

  for (const needle of asArray(options.notContains)) {
    if (combined.includes(needle)) {
      throw new Error([
        `${name}: expected output not to contain ${JSON.stringify(needle)}`,
        `command: node ${path.relative(repoRoot, cliPath)} ${cliArgs.join(' ')}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join('\n'));
    }
  }

  checkCount += 1;
  if (verbose) process.stdout.write(`ok ${checkCount} ${name}\n`);
  else process.stdout.write('.');
  return options.capture ? { stdout, stderr, combined } : undefined;
}

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function startMockProviderServer() {
  const child = spawn(process.execPath, ['-e', mockProviderServerSource()], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await readMockServerPort(child);
  return {
    port,
    server: {
      close(callback) {
        const finish = () => callback?.();
        if (child.exitCode !== null) {
          finish();
          return;
        }
        child.once('exit', finish);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      },
    },
  };
}

function readMockServerPort(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for mock provider server port.'));
    }, 5000);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf-8');
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;
      clearTimeout(timer);
      const line = buffer.slice(0, lineEnd).trim();
      const port = Number.parseInt(line, 10);
      if (!Number.isFinite(port)) {
        reject(new Error(`Mock provider server printed invalid port: ${line}`));
        return;
      }
      resolve(port);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Mock provider server exited before startup with code ${code}.`));
    });
  });
}

function mockProviderServerSource() {
  return String.raw`
const http = require('node:http');

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const rawBody = await readRequestBody(request);
  let requestBody = {};
  try {
    requestBody = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    requestBody = {};
  }

  if (request.method === 'GET' && url.pathname === '/api/tags') {
    writeJson(response, {
      models: [
        { name: 'gemma4:e4b' },
        { name: 'qwen3:8b' },
      ],
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/chat') {
    if (requestBody.stream === false) {
      writeJson(response, { message: { content: 'mock response' }, done: true, done_reason: 'stop' });
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.write(JSON.stringify({ message: { content: 'mock ' }, done: false }) + '\n');
    response.write(JSON.stringify({ message: { content: 'response' }, done: true }) + '\n');
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(response, {
      data: [
        { id: 'gpt-test' },
      ],
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    writeJson(response, {
      choices: [
        { message: { content: 'mock openai response' }, finish_reason: 'stop' },
      ],
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/responses') {
    writeJson(response, {
      status: 'completed',
      output_text: 'mock responses response',
    });
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('No mock route for ' + request.method + ' ' + url.pathname);
});

server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

function readRequestBody(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function writeJson(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
`;
}
