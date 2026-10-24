// Bundles the Cloudflare Worker into dist/cloudflare. Deploys upload this file
// unchanged (`no_bundle`), so local tests and the marifold CLI ship the same code.
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist/cloudflare');
fs.rmSync(output, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'src/cloudflare/worker.ts')],
  outfile: path.join(output, 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import'],
  external: ['cloudflare:*', 'node:*'],
  // Bundle the protocol from source: its compiled CommonJS would `require`
  // node:crypto, which an ES module Worker cannot do.
  alias: { '@marifold/workspace-protocol': path.join(root, '../../packages/workspace-protocol/src/index.ts') },
  legalComments: 'none',
  logLevel: 'warning',
});
