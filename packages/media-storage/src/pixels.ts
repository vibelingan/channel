import { createHash } from 'node:crypto';
import { CATALOG_IMAGE_MAX_BYTES, CATALOG_IMAGE_MIME_TYPES } from '@vibelingan-channel/shared';
import type sharp from 'sharp';
import { readPngAnimation } from './png-animation.ts';

const maxPixels = 268402689;
const mimeFormats = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;
export type CatalogImagePixels =
  | {
      status: 'decoded';
      kind: 'catalog-image-pixels-v1';
      checksumSha256: string;
      width: number;
      height: number;
      pages: number;
    }
  | { status: 'invalid'; reason: 'size' | 'content' }
  | { status: 'retry'; reason: 'timeout' | 'unavailable' };

/** Checks actual pixels; the caller must separately bind the current stored image. */
export async function decodeCatalogImagePixels(
  bytes: Uint8Array,
  mimeType: string,
  options: { timeoutMs?: number; loadDecoder?: () => Promise<typeof sharp> } = {},
): Promise<CatalogImagePixels> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new RangeError('Invalid pixel check deadline');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CATALOG_IMAGE_MAX_BYTES)
    return { status: 'invalid', reason: 'size' };
  if (!CATALOG_IMAGE_MIME_TYPES.some((mime) => mime === mimeType))
    return { status: 'invalid', reason: 'content' };
  const input = Buffer.from(bytes);
  const animation = mimeType === 'image/png' ? readPngAnimation(input) : undefined;
  if (animation === null) return { status: 'invalid', reason: 'content' };
  const pages = animation?.pages ?? containerPages(input, mimeType);
  if (pages === null) return { status: 'invalid', reason: 'content' };
  const checksumSha256 = createHash('sha256').update(input).digest('hex');
  const remainingMs = timeoutMs - (performance.now() - startedAt);
  if (remainingMs <= 0) return { status: 'retry', reason: 'timeout' };
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pipeline: ReturnType<typeof sharp> | undefined;
  const deadline = new Promise<CatalogImagePixels>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve({ status: 'retry', reason: 'timeout' });
    }, remainingMs);
  });
  const decode = async (): Promise<CatalogImagePixels> => {
    let decoder: typeof sharp;
    try {
      decoder = await (
        options.loadDecoder ?? (async () => (await import('#catalog-image-decoder')).default)
      )();
    } catch {
      return { status: 'retry', reason: 'unavailable' };
    }
    if (expired) return { status: 'retry', reason: 'timeout' };
    try {
      pipeline = decoder(input, { animated: true, failOn: 'warning', limitInputPixels: maxPixels });
      const metadata = await pipeline.metadata();
      if (expired) return { status: 'retry', reason: 'timeout' };
      const width = metadata.width;
      const height = metadata.pageHeight ?? metadata.height;
      if (
        !width ||
        !height ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width * height * (animation ? 1 : pages) > maxPixels ||
        (metadata.pages !== undefined && metadata.pages !== (animation ? 1 : pages)) ||
        metadata.format !== Reflect.get(mimeFormats, mimeType)
      )
        return { status: 'invalid', reason: 'content' };
      // Decode every scanline/frame; decoder shrink shortcuts must not skip damaged input.
      const output = await pipeline
        .resize(1, 1, { fit: 'fill', fastShrinkOnLoad: false })
        .raw()
        .timeout({ seconds: 2 })
        .toBuffer({ resolveWithObject: true });
      if (expired) return { status: 'retry', reason: 'timeout' };
      if (
        output.info.width !== 1 ||
        output.info.height !== (animation ? 1 : pages) ||
        (output.info.pages ?? 1) !== (animation ? 1 : pages) ||
        output.data.length !== (animation ? 1 : pages) * output.info.channels
      )
        return { status: 'invalid', reason: 'content' };
      if (animation) {
        for (const frame of animation.frames) {
          if (expired) return { status: 'retry', reason: 'timeout' };
          pipeline = decoder(frame, { failOn: 'warning', limitInputPixels: maxPixels });
          const decoded = await pipeline
            .resize(1, 1, { fit: 'fill', fastShrinkOnLoad: false })
            .raw()
            .timeout({ seconds: 2 })
            .toBuffer({ resolveWithObject: true });
          if (expired) return { status: 'retry', reason: 'timeout' };
          if (
            decoded.info.width !== 1 ||
            decoded.info.height !== 1 ||
            decoded.data.length !== decoded.info.channels
          )
            return { status: 'invalid', reason: 'content' };
          pipeline.destroy();
        }
      }
      return {
        status: 'decoded',
        kind: 'catalog-image-pixels-v1',
        checksumSha256,
        width,
        height,
        pages,
      };
    } catch (error) {
      return error instanceof Error && /timeout/i.test(error.message)
        ? { status: 'retry', reason: 'timeout' }
        : { status: 'invalid', reason: 'content' };
    }
  };
  try {
    return await Promise.race([decode(), deadline]);
  } finally {
    clearTimeout(timer);
    pipeline?.destroy();
  }
}

/** Some decoders tolerate a truncated animation and silently return its first frame. */
function containerPages(bytes: Buffer, mime: string): number | null {
  if (mime === 'image/jpeg')
    return bytes[0] === 255 && bytes[1] === 216 && bytes.lastIndexOf(Buffer.from([255, 217])) >= 2
      ? 1
      : null;
  if (mime === 'image/png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    let offset = 8;
    let data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (
        length > bytes.length - offset - 12 ||
        (offset === 8 && (kind !== 'IHDR' || length !== 13))
      )
        return null;
      if (kind === 'IDAT') data = true;
      if (kind === 'IEND') return length === 0 && data ? 1 : null;
      offset += length + 12;
    }
    return null;
  }
  if (mime === 'image/webp') {
    if (
      bytes.length < 12 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    )
      return null;
    const end = bytes.readUInt32LE(4) + 8;
    if (end > bytes.length || end < 20) return null;
    let offset = 12;
    let frames = 0;
    while (offset + 8 <= end) {
      const length = bytes.readUInt32LE(offset + 4);
      if (length > end - offset - 8) return null;
      if (bytes.toString('ascii', offset, offset + 4) === 'ANMF') frames++;
      offset += 8 + length + (length % 2);
    }
    return offset === end ? Math.max(1, frames) : null;
  }
  if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return null;
  let offset = 13 + (bytes.readUInt8(10) & 128 ? 3 * 2 ** ((bytes.readUInt8(10) & 7) + 1) : 0);
  let frames = 0;
  const blocks = () => {
    while (offset < bytes.length) {
      const size = bytes.readUInt8(offset++);
      if (size === 0) return true;
      if (size > bytes.length - offset) return false;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const tag = bytes.readUInt8(offset++);
    if (tag === 59) return frames > 0 ? frames : null;
    if (tag === 33) {
      if (offset >= bytes.length) return null;
      offset++;
      if (!blocks()) return null;
    } else if (tag === 44) {
      if (offset + 9 > bytes.length) return null;
      const packed = bytes.readUInt8(offset + 8);
      offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      if (offset >= bytes.length || bytes.readUInt8(offset) < 2 || bytes.readUInt8(offset) > 8)
        return null;
      offset++;
      if (!blocks()) return null;
      frames++;
    } else return null;
  }
  return null;
}
