import sharp from 'sharp';

/** Small display image; the stored original remains unchanged. */
export async function avatarThumbnail(path: string): Promise<Buffer> {
  return sharp(path, { limitInputPixels: 8192 * 8192, animated: false })
    .rotate()
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
}
