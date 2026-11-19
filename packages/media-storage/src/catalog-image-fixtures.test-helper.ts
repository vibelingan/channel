import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

let large: Promise<Buffer> | undefined;
/** Real pixels with deliberately uncompressed PNG bytes, never a business image. */
export function largeCatalogPng() {
  large ??= sharp({
    create: { width: 1600, height: 1000, channels: 3, background: '#234567' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return large;
}

// Exceed the web-image preparation threshold without testing WAN capacity at the same time.
export async function retryCatalogPng() {
  const width = 1600;
  const height = 1000;
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels, 0x34);
  randomBytes(width * 40 * channels).copy(pixels);
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/** Padding is a standards-compliant GIF comment; both real animation frames remain intact. */
export async function commentedAnimation(minimumBytes: number) {
  const raw = Buffer.alloc(12 * 20 * 4, 255);
  raw.fill(0, 12 * 10 * 4);
  for (let i = 12 * 10 * 4 + 3; i < raw.length; i += 4) raw[i] = 255;
  const gif = await sharp(raw, { raw: { width: 12, height: 20, channels: 4, pageHeight: 10 } })
    .gif({ delay: [100, 100] })
    .toBuffer();
  if (gif.at(-1) !== 0x3b) throw Error('Expected a GIF trailer');
  const chunk = Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 0x61)]);
  const chunks = Math.ceil(Math.max(0, minimumBytes - gif.length) / chunk.length);
  return Buffer.concat([
    gif.subarray(0, -1),
    Buffer.from([0x21, 0xfe]),
    ...Array.from({ length: chunks }, () => chunk),
    Buffer.from([0, 0x3b]),
  ]);
}
