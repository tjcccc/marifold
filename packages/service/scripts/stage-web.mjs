import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(scriptDir, '..');
const sourceDir = path.resolve(serviceDir, '../../apps/web/dist');
const targetDir = path.join(serviceDir, 'dist', 'web');

if (!fs.statSync(path.join(sourceDir, 'index.html'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Built Web UI not found at ${sourceDir}.`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

process.stdout.write(`Staged Web UI in ${targetDir}.\n`);
