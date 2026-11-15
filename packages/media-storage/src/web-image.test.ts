import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { createCatalogWebImage } from './web-image.ts';

test('real PNG pixels become a bounded WebP without modifying the original', async () => {
  const input = await sharp({
    create: { width: 1920, height: 1080, channels: 4, background: '#12345680' },
  })
    .png()
    .toBuffer();
  const hash = createHash('sha256').update(input).digest('hex');
  const result = await createCatalogWebImage(input, 'image/png');
  const meta = await sharp(result.bytes).metadata();
  assert.equal(result.sourceSha256, hash);
  assert.equal(createHash('sha256').update(input).digest('hex'), hash);
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
  assert.equal(meta.hasAlpha, true);
  assert.equal(result.checksumSha256, createHash('sha256').update(result.bytes).digest('hex'));
  assert.ok(result.byteSize < 3_000_000);
});
test('small images keep their dimensions and invalid data is rejected', async () => {
  const input = await sharp({
    create: { width: 16, height: 24, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  const result = await createCatalogWebImage(input, 'image/png');
  assert.equal(result.width, 16);
  assert.equal(result.height, 24);
  await assert.rejects(createCatalogWebImage(input.subarray(0, input.length - 10), 'image/png'));
  await assert.rejects(createCatalogWebImage(input, 'image/jpeg'));
});
