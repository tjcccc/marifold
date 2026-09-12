import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { avatarThumbnail } from '../src/images/AvatarThumbnail';

it('bounds display avatars without changing the original file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'marifold-thumbnail-'));
  try {
    const file = join(dir, 'avatar.png');
    await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toFile(file);
    const original = readFileSync(file);
    const thumbnail = await avatarThumbnail(file);
    const metadata = await sharp(thumbnail).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
    expect(thumbnail.length).toBeLessThan(32000);
    expect(readFileSync(file)).toEqual(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
