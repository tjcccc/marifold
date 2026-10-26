import * as fs from 'fs';
import * as path from 'path';

/**
 * Small stored pictures: profile avatars and project icons. One file per
 * owner, `<base>.<ext>` in its directory; PNG, JPEG or WebP up to 2 MB.
 */

/** Accepted media types → the stored file extension. */
const AVATAR_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
// The web client crops to 512² and compresses as WebP. Keep the existing limit
// for API clients, older avatars and browsers that fall back to PNG.
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export function findAvatarFile(dir: string, base: string): { path: string; mediaType: string } | undefined {
  for (const [mediaType, ext] of Object.entries(AVATAR_MEDIA_TYPES)) {
    const filePath = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(filePath)) { return { path: filePath, mediaType }; }
  }
  return undefined;
}

/** Why an image cannot be stored, or undefined when it can. */
export function avatarImageProblem(image: Buffer, mediaType: string, noun: string): string | undefined {
  if (!AVATAR_MEDIA_TYPES[mediaType]) {
    return `Unsupported ${noun} type '${mediaType}'. Use image/png, image/jpeg, or image/webp.`;
  }
  if (image.length === 0 || image.length > MAX_AVATAR_BYTES) {
    return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} images must be between 1 byte and ${MAX_AVATAR_BYTES / 1024} KB.`;
  }
  return undefined;
}

/** Replace the stored image, including one of another type. Validate it with
 * `avatarImageProblem` first. */
export function writeAvatarFile(dir: string, base: string, image: Buffer, mediaType: string): { path: string; mediaType: string } {
  fs.mkdirSync(dir, { recursive: true });
  removeAvatarFiles(dir, base);
  const filePath = path.join(dir, `${base}.${AVATAR_MEDIA_TYPES[mediaType]}`);
  fs.writeFileSync(filePath, image);
  return { path: filePath, mediaType };
}

export function removeAvatarFiles(dir: string, base: string): boolean {
  let removed = false;
  for (const ext of Object.values(AVATAR_MEDIA_TYPES)) {
    const filePath = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed = true;
    }
  }
  return removed;
}
