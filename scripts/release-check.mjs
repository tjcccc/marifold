#!/usr/bin/env node
// Publish guard. `pnpm gate` runs the full gate on a clean tree and then
// `release-check.mjs --stamp` records the commit it passed on. Every public
// package's prepublishOnly runs this script without arguments, so npm refuses
// to publish a commit the gate has not passed, a dirty tree, or a build whose
// CLI reports a different version.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stampFile = path.join(root, 'node_modules', '.cache', 'marifold-gate.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function fail(message) {
  console.error(`Release check failed: ${message}`);
  process.exit(1);
}

if (git('status', '--porcelain')) { fail('the working tree has uncommitted changes. Commit them, then run pnpm gate.'); }
const head = git('rev-parse', 'HEAD');
if (process.argv.includes('--clean-only')) { process.exit(0); }

if (process.argv.includes('--stamp')) {
  mkdirSync(path.dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, JSON.stringify({ head, version, at: new Date().toISOString() }, null, 2));
  console.log(`Gate passed on ${head.slice(0, 7)} (v${version}); publishing is allowed for this commit.`);
  process.exit(0);
}

execFileSync(process.execPath, [path.join(root, 'scripts', 'check-versions.mjs')], { stdio: 'inherit' });
const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : undefined;
if (stamp?.head !== head || stamp?.version !== version) { fail(`the gate has not passed on ${head.slice(0, 7)} (v${version}). Run pnpm gate first.`); }
const cli = path.join(root, 'packages', 'cli', 'dist', 'index.js');
const built = existsSync(cli) ? execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim() : '(not built)';
if (built !== version) { fail(`the built CLI reports ${built}, expected ${version}. Rebuild with pnpm gate.`); }
console.log(`Release check passed for v${version} at ${head.slice(0, 7)}.`);
