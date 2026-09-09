import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// Owned, disposable database only. No live credentials, API calls or product writes.
import { basename, dirname, resolve } from 'node:path';
import { JsonFileAdapter } from '../../apps/local-server/src/json-adapter.ts';
import { seed } from '../../apps/local-server/src/seed.ts';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '../../packages/catalog-import/src/source-observations.ts';
import { setAdapter } from '../../packages/db/src/index.ts';

const file = resolve(process.argv[2] ?? '');
if (
  basename(file) !== 'db.json' ||
  !basename(dirname(file)).startsWith('channel-catalog-e2e-') ||
  dirname(dirname(file)) !== resolve(tmpdir())
)
  throw new Error('Refusing non-disposable catalog DB.');
const db = new JsonFileAdapter(file);
setAdapter(db);
await seed(db);
// The deployed hero points at three reviewed image identities. Supply owned
// synthetic bytes under those identities in this disposable DB, not live COS.
const heroIds = [
  '0e0afdc26a68209e00523aa031e56460',
  '7b76ee416a68209d0110670520562928',
  '0e0afdc26a68209c00523a7b50cb8647',
];
for (const id of heroIds)
  await db.createDocWithId('images', id, {
    name: 'Local hero fixture',
    mimeType: 'image/png',
    status: 'active',
    publishedRefCount: 1,
    refCount: 1,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
  });
const heroOwner = await db.findByField('products', 'name', 'AuraBeat Classic');
if (!heroOwner) throw new Error('Owned hero product fixture missing');
await db.update('products', heroOwner._id, { imageIds: heroIds });
const product = await db.findByField('products', 'name', 'SonicAir Move');
if (!product) throw new Error('Owned seed fixture missing');
await db.update('products', product._id, {
  slug: 'local-linked-pricing',
  unitPrice: undefined,
  wholesalePrice: undefined,
  alibabaPrimarySourceKey: 'a'.repeat(64),
  alibabaCatalogPricing: {
    schemaVersion: 'alibaba-catalog-pricing-v1',
    source: 'alibaba',
    mode: 'tiered',
    currency: 'USD',
    sourceMoq: 2,
    syncedAt: '2026-09-03T08:16:00.000Z',
    tiers: [
      { minQuantity: 2, maxQuantity: 499, unitAmountMinor: 570 },
      { minQuantity: 500, maxQuantity: 999, unitAmountMinor: 500 },
      { minQuantity: 1000, unitAmountMinor: 380 },
    ],
  },
});

if (process.env.E2E_CATALOG_FORMAL === '1') {
  const sourceKey = 'a'.repeat(64);
  const urls = ['https://s.alicdn.com/formal-front.png', 'https://s.alicdn.com/formal-back.png'];
  const mediaDir = resolve(dirname(file), 'media');
  await mkdir(mediaDir, { recursive: true });
  for (const [i, url] of urls.entries()) {
    const id = `formal-image-${i}`;
    const storagePath = `${id}.png`;
    await writeFile(
      resolve(mediaDir, storagePath),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    await db.createDocWithId('images', id, {
      status: 'active',
      storageProvider: 'local-disk',
      storagePath,
      storageFileId: `local-disk:${storagePath}`,
      mimeType: 'image/png',
      publishedRefCount: 1,
    });
    await db.createDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', url), {
      kind: 'media',
      provider: 'alibaba',
      sourceUrl: url,
      imageId: id,
    });
  }
  const observation = {
    schemaVersion: 'catalog-source-observation-v1',
    source: {
      provider: 'alibaba',
      sourceProductKey: sourceKey,
      accountKey: 'local-only',
      observedAt: '2026-09-09T00:00:00.000Z',
      captureMode: 'selected',
      completeness: 'full-product',
    },
    identity: { title: product.name, matchHints: {}, attributes: [] },
    lifecycle: { sourceListingStatus: 'published' },
    content: {
      media: urls.map((sourceUrl, position) => ({
        sourceUrl,
        position,
        role: position === 0 ? 'primary' : 'gallery',
      })),
      description: {
        text: product.description,
        sanitized: true,
        placeholder: false,
        provenance: 'description',
      },
    },
    variants: Array.from({ length: 21 }, (_, i) => ({
      sourceVariantKey: `sku-${i}`,
      sku: `FORMAL-${i}`,
      options: [{ sourceName: 'Color', value: `Color ${i}` }],
      inventory: [],
      media: [{ sourceUrl: urls[i % 2], position: 0, role: 'primary' }],
    })),
    offers: [
      {
        sourceOfferKey: 'formal-quote',
        kind: 'supplier',
        pricing: {
          mode: 'tiered',
          currency: 'USD',
          minimumOrderQuantity: 2,
          tiers: [
            { minimumQuantity: 2, maximumQuantity: 499, unitAmountMinor: 570 },
            { minimumQuantity: 500, unitAmountMinor: 380 },
          ],
        },
      },
    ],
    evidence: [{ kind: 'raw-payload', evidenceId: 'local-only' }],
    warnings: [],
  };
  const valid = validateCatalogSourceObservation(observation);
  if (!valid.ok) throw new Error(valid.errors.join('; '));
  await db.createDocWithId(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', sourceKey),
    { observation: valid.value },
  );
  await db.update('products', product._id, {
    imageIds: ['formal-image-0', 'formal-image-1'],
    alibabaSourceImageUrls: urls,
    alibabaReviewPending: true,
  });
}
