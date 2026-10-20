import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { isStoredCatalogImageRecord } from '../../../packages/db/src/catalog-image-input.ts';
import { decodeCatalogImagePixels } from '../../../packages/media-storage/src/pixels.ts';
import { seedRawCatalog } from '../../../tests/fixtures/seed-raw-catalog.ts';
import { JsonFileAdapter } from './json-adapter.ts';

test('raw formal fixtures contain real decodable media with exact storage metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-raw-media-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const media = join(directory, 'media');
  await mkdir(media);
  const adapter = new JsonFileAdapter(join(directory, 'db.json'));
  setAdapter(adapter);
  await seedRawCatalog(adapter, media);
  const { items, total } = await adapter.list({
    collection: 'images',
    page: 1,
    pageSize: 100,
    search: '',
    sort: [{ field: '_id', dir: 'asc' }],
  });
  assert.equal(items.length, total);
  assert.ok(items.some((image) => image._id.startsWith('raw-wire-')));
  assert.equal(items.filter((image) => image._id.startsWith('raw-color-')).length, 9);
  await t.test('the stored record contract matches bytes and checksum', async () => {
    for (const image of items) {
      assert.ok(isStoredCatalogImageRecord(image, image._id), image._id);
      assert.equal(image.storageFileId, `local-disk:${image.storagePath}`);
      const bytes = await readFile(join(media, String(image.storagePath)));
      assert.equal(image.byteSize, bytes.byteLength, image._id);
      assert.equal(image.checksumSha256, createHash('sha256').update(bytes).digest('hex'));
    }
  });
  await t.test(
    'the production decoder accepts every stored image, without seeded receipts',
    async () => {
      for (const image of items) {
        const bytes = await readFile(join(media, String(image.storagePath)));
        const decoded = await decodeCatalogImagePixels(bytes, String(image.mimeType));
        assert.equal(decoded.status, 'decoded', `${image._id}: ${JSON.stringify(decoded)}`);
        assert.equal(image.catalogImageValidation, undefined);
      }
    },
  );
});
