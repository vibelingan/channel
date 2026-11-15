import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { decodeCatalogImagePixels } from './pixels.ts';

/** Run during preparation, never in the public request path. Originals are retained. */
export async function createCatalogWebImage(bytes: Uint8Array, mimeType: string) {
  const source = await decodeCatalogImagePixels(bytes, mimeType);
  if (source.status !== 'decoded' || source.pages !== 1)
    throw Error('A complete still image is required; animations are not flattened');
  const output = await sharp(Buffer.from(bytes), { failOn: 'warning', limitInputPixels: 268402689 })
    .rotate()
    .resize({ width: 1280, withoutEnlargement: true })
    .toColourspace('srgb')
    .webp({ quality: 82, alphaQuality: 100, effort: 4 })
    .timeout({ seconds: 5 })
    .toBuffer({ resolveWithObject: true });
  if (!output.data.length || output.data.length > 3_000_000 || output.info.height > 16383)
    throw Error('Generated web image exceeds the delivery budget');
  return {
    bytes: output.data,
    sourceSha256: source.checksumSha256,
    mimeType: 'image/webp' as const,
    byteSize: output.data.length,
    width: output.info.width,
    height: output.info.height,
    checksumSha256: createHash('sha256').update(output.data).digest('hex'),
  };
}
