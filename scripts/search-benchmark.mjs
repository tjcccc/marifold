#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { BuiltInSearchBackend, DuckDuckGoBackend, FirecrawlBackend } = require('../packages/core/dist/index.js');
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const count = Number(arg('--count', '30'));
const providers = arg('--providers', 'builtin,duckduckgo').split(',');
const output = path.resolve(arg('--output', path.join(root, 'output/search-benchmark.json')));
const queries = JSON.parse(readFileSync(path.join(root, 'scripts/search-queries.json'), 'utf8')).slice(0, count);
const factories = {
  builtin: () => new BuiltInSearchBackend(),
  duckduckgo: () => new DuckDuckGoBackend(),
  firecrawl: () => new FirecrawlBackend({ apiKey: process.env.FIRECRAWL_API_KEY, scrape: false }),
};
if (!Number.isInteger(count) || count < 1 || providers.some(provider => !factories[provider])) {
  throw new Error('Use --count <positive integer> --providers builtin,duckduckgo,firecrawl.');
}
const rows = [];
const skipped = [];
for (const provider of providers) {
  if (provider === 'firecrawl' && !process.env.FIRECRAWL_API_KEY) {
    skipped.push('Firecrawl: FIRECRAWL_API_KEY is not set; no paid or keyless requests attempted.');
  }
}
const active = providers.filter(provider => !(provider === 'firecrawl' && !process.env.FIRECRAWL_API_KEY));
for (const [index, entry] of queries.entries()) {
  // Rotate order to reduce ordering bias; fresh instances measure uncached searches.
  const order = [...active.slice(index % active.length), ...active.slice(0, index % active.length)];
  for (const provider of order) {
    const start = performance.now();
    let timer;
    try {
      const results = await Promise.race([
        factories[provider]().search(entry.query, 5, AbortSignal.timeout(12_000)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Benchmark deadline exceeded')), 15_000); }),
      ]);
      rows.push({ ...entry, provider, ok: true, ms: Math.round(performance.now() - start),
        outputBytes: Buffer.byteLength(JSON.stringify(results)), results });
    } catch (error) {
      rows.push({ ...entry, provider, ok: false, ms: Math.round(performance.now() - start), error: error.message });
    } finally { clearTimeout(timer); }
    console.log(`${provider} ${index + 1}/${queries.length}: ${rows.at(-1).ok ? rows.at(-1).results.length + ' results' : 'failed'} (${rows.at(-1).ms} ms)`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
const summary = Object.fromEntries(active.map(provider => {
  const own = rows.filter(row => row.provider === provider);
  const times = own.map(row => row.ms).sort((a, b) => a - b);
  return [provider, { requests: own.length, successful: own.filter(row => row.ok).length,
    nonempty: own.filter(row => row.ok && row.results.length).length,
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.max(0, Math.ceil(times.length * .95) - 1)] }];
}));
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), skipped, summary, rows,
  notes: 'Uncached, five results, serial requests. Bytes are not model token counts. Relevance/freshness require source review; successful retrieval is not a quality score.' }, null, 2) + '\n');
console.log(JSON.stringify({ output, skipped, summary }, null, 2));
