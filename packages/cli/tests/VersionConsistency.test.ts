import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(root, 'scripts/check-versions.mjs');

describe('release version consistency', () => {
  it('keeps all repository package versions and the CLI synchronized', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects newly added packages, private apps, and CLI versions that drift', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'marifold-versions-'));
    const write = (relative: string, content: string) => {
      const target = path.join(fixture, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    try {
      write('package.json', JSON.stringify({ version: '1.2.3' }));
      write('packages/new-package/package.json', JSON.stringify({ version: '1.2.2' }));
      write('apps/private-app/package.json', JSON.stringify({ private: true, version: '1.2.2' }));
      write('packages/cli/src/index.ts', ".version('1.2.2')");
      mkdirSync(path.join(fixture, 'scripts'));
      const fixtureScript = path.join(fixture, 'scripts/check-versions.mjs');
      copyFileSync(script, fixtureScript);
      const result = spawnSync(process.execPath, [fixtureScript], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must match 1.2.3');
      expect(result.stderr).toContain('packages/new-package/package.json: 1.2.2');
      expect(result.stderr).toContain('apps/private-app/package.json: 1.2.2');
      expect(result.stderr).toContain('packages/cli/src/index.ts: 1.2.2');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
