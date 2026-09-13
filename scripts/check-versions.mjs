#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const expected = JSON.parse(read('package.json')).version;
const mismatches = [];
const manifests = globSync(['packages/*/package.json', 'apps/*/package.json'], { cwd: root }).sort();

for (const manifest of manifests) {
  const { version } = JSON.parse(read(manifest));
  if (version !== expected) mismatches.push(`${manifest}: ${version ?? '(missing version)'}`);
}

const cliVersion = read('packages/cli/src/index.ts').match(/\.version\(['"]([^'"]+)['"]\)/)?.[1];
if (cliVersion !== expected) mismatches.push(`packages/cli/src/index.ts: ${cliVersion ?? '(missing version)'}`);

if (mismatches.length) {
  console.error(`Version mismatch: all workspace packages and the CLI must match ${expected}.\n${mismatches.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`All ${manifests.length} workspace packages and the CLI match ${expected}.`);
}
