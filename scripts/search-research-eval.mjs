#!/usr/bin/env node
// Local model only; disposable state. --fixture exercises stale-source recovery
// with synthetic weather, never presented as actual observations.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { MarifoldRuntime, ToolRegistry } = require('../packages/core/dist');
const { WebSearchTool } = require('../packages/core/dist/agent/tools/WebSearchTool');
const { ReadWebPageTool } = require('../packages/core/dist/agent/tools/ReadWebPageTool');
const { WebPageReader } = require('../packages/core/dist/search/WebPageReader');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const model = arg('--model', 'gemma4:e4b-mlx');
if (/cloud/i.test(model)) throw new Error('Choose a local model.');
const fixture = args.includes('--fixture');
const root = mkdtempSync(path.join(tmpdir(), 'marifold-research-eval-'));
const profilesDir = path.join(root, 'profiles');
mkdirSync(path.join(profilesDir, 'default'), { recursive: true });
writeFileSync(path.join(profilesDir, 'default/INSTRUCTIONS.md'), 'Answer the user’s question briefly with supporting source links.');
const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const config = {
  default: { provider: 'ollama', model, profile: 'default', think: false, timeoutSeconds: 90, maxOutputTokens: 1500 },
  models: { options: [`ollama/${model}`] }, memory: { sizeLimit: 1000, contextLimit: 120 },
  paths: { profilesDir, sessionsDb: path.join(root, 'sessions.db'), tasksDir: path.join(root, 'tasks'), skillsDir: path.join(root, 'skills'), appsDir: path.join(root, 'apps') },
  providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434' } },
  webSearch: { enabled: true, provider: 'builtin', maxResults: 5 },
};
let registry;
const calls = [];
if (fixture) {
  registry = new ToolRegistry();
  let searches = 0;
  registry.register(new WebSearchTool({ search: async query => {
    calls.push({ tool: 'search', query });
    const url = ++searches === 1 ? 'https://example.com/old' : 'https://example.com/current';
    return [{ title: '上海今日天气', url, snippet: '上海天气详情、气温和降水预报。打开详情查看。' }];
  } }));
  registry.register(new ReadWebPageTool({ read: async url => {
    calls.push({ tool: 'read', url });
    return { url, title: 'Shanghai forecast', text: url.endsWith('/old')
      ? '发布日期 2020-01-01。上海天气晴，气温10°C。这是历史存档。'
      : `发布日期 ${today}。上海今天阵雨，气温23–28°C。降水概率80%。`,
      fetchedAt: new Date().toISOString(), truncated: false };
  } }));
}
const runtime = new MarifoldRuntime({ loadedConfig: { config, configPath: path.join(root, 'config.toml'), foundConfig: true } });
if (!fixture) {
  registry = new ToolRegistry();
  for (const tool of runtime.createDefaultToolRegistry().list()) {
    if (tool.definition.name !== 'read_web_page') registry.register(tool);
  }
  const reader = new WebPageReader();
  registry.register(new ReadWebPageTool({ read: async (...args) => {
    const page = await reader.read(...args);
    calls.push({ tool: 'read', ...page });
    return page;
  } }));
}
const events = [];
const start = performance.now();
let error;
try {
  for await (const event of runtime.createAgentRunner(undefined, registry).run({
    objective: (fixture ? '这是离线测试，web_search 和 read_web_page 已连接到模拟数据。请先调用 web_search，再读取返回的 example.com 页面；若日期过期请再次搜索。使用本测试的模拟数据回答即可。' : '') + arg('--objective', '帮我查一下上海今天的天气，包括气温和是否下雨。'), cwd: root, maxIterations: 8,
    signal: AbortSignal.timeout(180_000), approvalHandler: async call => ({ approved: call.kind === 'network' }),
  })) {
    events.push(event);
    if (['tool_request', 'tool_result', 'completed', 'failed'].includes(event.type)) console.log(JSON.stringify(event));
  }
} catch (e) { error = e.message; }
finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
const output = path.resolve(arg('--output', `output/search-benchmark-research-${fixture ? 'fixture' : 'live'}.json`));
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ fixture, model, today, ms: Math.round(performance.now() - start), error, calls, events }, null, 2) + '\n');
console.log(output);
