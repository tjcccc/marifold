import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
it.each(['bridge', 'missing/nested/bridge'])('prepares %s without copying personal state or overwriting a directory', (directory) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marifold-bridge-package-'));
  const output = path.join(root, directory);
  try {
    const result = spawnSync(process.execPath, ['dist/index.js', 'workspace', 'bridge', 'prepare', output], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies['@marifold/workspace-protocol']).toBe('file:vendor/workspace-protocol');
    expect(fs.existsSync(path.join(output, 'api/bridge.ts'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'HOSTING.md'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'setup.sh'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'setup/setup.py'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'vendor/workspace-protocol/dist/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(output, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(output, 'control.db'))).toBe(false);
    fs.writeFileSync(path.join(output, 'keep.txt'), 'existing data');
    const repeat = spawnSync(process.execPath, ['dist/index.js', 'workspace', 'bridge', 'prepare', output], {
      encoding: 'utf8',
    });
    expect(repeat.status).toBe(1);
    expect(fs.readFileSync(path.join(output, 'keep.txt'), 'utf8')).toBe('existing data');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
