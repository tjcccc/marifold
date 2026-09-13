#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { MarifoldRuntime } = require('../packages/core/dist/index.js');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const model = arg('--model', 'gemma4:e4b-mlx');
if (/cloud/i.test(model)) throw new Error('This smoke test is for a local model.');
const providers = arg('--providers', 'builtin,duckduckgo').split(',');
if (providers.some(p => !['builtin', 'duckduckgo'].includes(p))) throw new Error('Choose builtin or duckduckgo.');
const cases = [
  'Use web_search to find the official Node.js 24.0.0 release announcement. Return its URL and one fact from the search results. If search fails, say so.',
  '请使用 web_search 查找 Python pathlib 官方文档。给出官方链接和一条搜索结果支持的信息。搜索失败时请明确说明。',
];
const rows = [];
for (const provider of providers) {
  for (const objective of cases) {
    const root = mkdtempSync(path.join(tmpdir(), 'marifold-search-eval-'));
    const profilesDir = path.join(root, 'profiles');
    mkdirSync(path.join(profilesDir, 'default'), { recursive: true });
    writeFileSync(path.join(profilesDir, 'default/INSTRUCTIONS.md'), 'Answer briefly. Use web_search when requested. Only report facts supported by tool results.');
    const config = {
      default: { provider: 'ollama', model, profile: 'default', think: false, timeoutSeconds: 60, maxOutputTokens: 1200 },
      models: { options: [`ollama/${model}`] }, memory: { sizeLimit: 1000, contextLimit: 120 },
      paths: { profilesDir, sessionsDb: path.join(root, 'sessions.db'), tasksDir: path.join(root, 'tasks'), skillsDir: path.join(root, 'skills'), appsDir: path.join(root, 'apps') },
      providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434' } },
      webSearch: { enabled: true, provider, maxResults: 5 },
    };
    const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(root, 'config.toml'), foundConfig: true } });
    const events = [];
    const start = performance.now();
    try {
      for await (const event of runtime.createAgentRunner().run({ objective, cwd: root, maxIterations: 3,
        signal: AbortSignal.timeout(90_000), approvalHandler: async call => ({ approved: call.kind === 'network' }),
      })) events.push(event);
      rows.push({ model, provider, objective, ms: Math.round(performance.now() - start), events });
    } catch (error) { rows.push({ model, provider, objective, ms: Math.round(performance.now() - start), error: error.message, events }); }
    finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
    console.log(`${provider}: ${rows.at(-1).ms} ms; ${events.filter(e => e.type === 'tool_request').length} tool requests`);
  }
}
const output = path.resolve(arg('--output', 'output/search-benchmark-agent.json'));
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + '\n');
console.log(output);
