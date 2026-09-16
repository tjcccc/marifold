import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { createArtifactPreview } from '../src/agent/ArtifactPreview';
import { listRunArtifacts } from '../src/agent/RunArtifacts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it('renders a bounded thumbnail while preserving the original full-resolution image', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-preview-')); directories.push(outputDir);
  const file = path.join(outputDir, 'desktop.png');
  const original = await sharp({ create: { width: 5120, height: 2880, channels: 3, background: '#407080' } }).png().toBuffer();
  fs.writeFileSync(file, original);
  const artifact = { ...listRunArtifacts({ outputDir })[0], path: file };
  const preview = await createArtifactPreview(artifact);
  expect(await sharp(preview).metadata()).toMatchObject({ width: 960, height: 540, format: 'webp' });
  expect(preview.length).toBeLessThan(original.length);
  expect(fs.readFileSync(file)).toEqual(original);
  await expect(createArtifactPreview({ ...artifact, mediaType: 'image/svg+xml' })).rejects.toThrow('no image preview');
  const link = path.join(outputDir, 'link.png'); fs.symlinkSync(file, link);
  await expect(createArtifactPreview({ ...artifact, path: link })).rejects.toThrow();
  fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>');
  await expect(createArtifactPreview(artifact)).rejects.toThrow('not a supported raster');
  fs.truncateSync(file, 33 * 1024 * 1024);
  await expect(createArtifactPreview(artifact)).rejects.toThrow('too large');
});
