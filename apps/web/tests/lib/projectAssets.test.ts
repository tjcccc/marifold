import { describe, expect, it } from 'vitest';
import type { ListedProjectAsset, RunArtifact } from '../../src/api/types';
import {
  formatStorage,
  limitBytes,
  limitParts,
  linkTarget,
  MAX_UPLOAD_BYTES,
  outputInAssets,
  sessionOutputs,
  uploadProblem,
} from '../../src/lib/projectAssets';

const artifact = (id: string, name: string, source?: RunArtifact['source']): RunArtifact => ({
  id, name, mediaType: 'text/plain', size: 10, ...(source ? { source } : {}),
});

const stored = (name: string, runIds?: string[]): ListedProjectAsset => ({
  kind: 'stored', id: `asset_${name}`, name, createdAt: '', updatedAt: '',
  version: 1, size: 10, mediaType: 'text/plain', sha256: '', ...(runIds ? { runIds } : {}),
});

describe('project asset helpers', () => {
  it('writes sizes as people say them', () => {
    expect([18 * 1024, 2.2 * 1024 * 1024, 34 * 1024 * 1024, 1024 ** 3].map(formatStorage)).toEqual(['18 KB', '2.2 MB', '34 MB', '1 GB']);
  });

  it('builds link targets: bare on this device, else @id and the path without its leading slash', () => {
    expect(linkTarget(undefined, ' ~/sprites ')).toBe('~/sprites');
    expect(linkTarget('dev_o', '~/sprites')).toBe('@dev_o/~/sprites');
    expect(linkTarget('dev_o', '/Volumes/data')).toBe('@dev_o/Volumes/data');
  });

  it('counts an output as added only when one of its runs saved an asset by its name', () => {
    const output = { runId: 'run_1', profile: 'painter', artifact: artifact('a1', 'out/logo.png') };
    expect(outputInAssets(output, [stored('logo.png', ['run_1'])])).toBe(true);
    expect(outputInAssets(output, [stored('logo.png', ['run_9'])])).toBe(false);
    expect(outputInAssets(output, [stored('logo.png')])).toBe(false);
    expect(outputInAssets(output, [stored('other.png', ['run_1'])])).toBe(false);
    // A delegated run's output, saved by the child run itself.
    const forwarded = { runId: 'run_1', profile: 'painter', artifact: artifact('a2', 'logo.png', { runId: 'run_child', artifactId: 'c1' }) };
    expect(outputInAssets(forwarded, [stored('logo.png', ['run_child'])])).toBe(true);
  });

  it('lists outputs of top-level runs only, since a parent already carries its children’s', () => {
    const outputs = sessionOutputs([
      { id: 'run_2', profile: 'painter', artifacts: [artifact('a2', 'b.txt')] },
      { id: 'run_child', profile: 'painter', parentRunId: 'run_2', artifacts: [artifact('c1', 'b.txt')] },
      { id: 'run_1', profile: 'dev_test' },
    ]);
    expect(outputs.map(output => `${output.runId}:${output.artifact.id}`)).toEqual(['run_2:a2']);
  });

  it('reads and writes the storage limit in MB or whole GB', () => {
    expect(limitParts(100 * 1024 * 1024)).toEqual({ value: '100', unit: 'MB' });
    expect(limitParts(2 * 1024 ** 3)).toEqual({ value: '2', unit: 'GB' });
    expect(limitParts(1.5 * 1024 ** 3)).toEqual({ value: '1536', unit: 'MB' });
    expect(limitBytes('2', 'GB')).toBe(2 * 1024 ** 3);
    expect(limitBytes('0.5', 'MB')).toBe(512 * 1024);
    expect([limitBytes('', 'MB'), limitBytes('0', 'MB'), limitBytes('ten', 'MB')]).toEqual([undefined, undefined, undefined]);
  });

  it('refuses an upload over the request limit before reading it', () => {
    expect(uploadProblem({ name: 'a.bin', size: MAX_UPLOAD_BYTES })).toBeUndefined();
    expect(uploadProblem({ name: 'a.bin', size: MAX_UPLOAD_BYTES + 1 })).toMatch(/at most 18 MB/);
  });
});
