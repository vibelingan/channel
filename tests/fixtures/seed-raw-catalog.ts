import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDraftForSource } from '../../apps/functions/alibaba-catalog-sync/src/linking.ts';
import type { JsonFileAdapter } from '../../apps/local-server/src/json-adapter.ts';
import {
  extractProductDetail,
  parseAlibabaApiResponse,
} from '../../packages/alibaba-catalog-sync/src/alibaba-contracts.ts';
import { normalizeProductDetail } from '../../packages/alibaba-catalog-sync/src/alibaba-normalizer.ts';
import { alibabaObservationAdapter } from '../../packages/alibaba-catalog-sync/src/alibaba-observation-adapter.ts';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '../../packages/catalog-import/src/source-observations.ts';

/** The raw envelope, normalizer and production materializer are the fixture's only data producers. */
async function seedRawObservation(db: JsonFileAdapter, raw: string) {
  const response = parseAlibabaApiResponse(raw);
  assert.equal(response.kind, 'success');
  if (response.kind !== 'success') throw new Error('Raw fixture envelope invalid');
  const detail = extractProductDetail(response.root);
  const now = '2026-09-10T00:00:00.000Z';
  const input = {
    connectionId: 'local-wire',
    detail,
    payloadId: createHash('sha256').update(raw).digest('hex'),
    observedAt: now,
    captureMode: 'selected' as const,
  };
  const batch = alibabaObservationAdapter.toObservations(input);
  const observation = batch.observations[0];
  assert.ok(observation, JSON.stringify(batch.findings));
  const normalized = normalizeProductDetail({ ...input, now });
  assert.ok(normalized.ok);
  const sourceKey = normalized.sourceProduct.sourceKey;
  await db.createDocWithId('alibabaSourceProducts', sourceKey, normalized.sourceProduct);
  await db.createDocWithId(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', sourceKey),
    { observation },
  );
  for (const offer of normalized.offers)
    await db.createDocWithId('alibabaSupplierOffers', offer.offerKey, offer);
  const draft = await createDraftForSource(sourceKey, { now });
  assert.ok(draft.ok);
  return { observation, draft };
}

export async function seedRawCatalog(db: JsonFileAdapter, mediaDirectory: string) {
  const raw = await readFile(new URL('./alibaba-camping-light-wire.json', import.meta.url), 'utf8');
  const { observation, draft } = await seedRawObservation(db, raw);
  assert.equal(observation.identity.attributes.length, 47);
  assert.equal(observation.content.description?.imageUrls?.length, 17);
  assert.deepEqual(observation.offers.find((o) => !o.sourceVariantKey)?.pricing, {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 767,
    minimumOrderQuantity: 1,
  });
  const gallery = observation.content.media.map((m) => m.sourceUrl);
  const description = observation.content.description?.imageUrls ?? [];
  const ids: string[] = [];
  for (const [i, original] of [...gallery, ...description].entries()) {
    const sourceUrl = original.replace(/^http:/, 'https:');
    const id = `raw-wire-image-${i}`;
    const storagePath = `${id}.png`;
    // Only pixels are synthetic; public/private image handlers still serve real bytes.
    await writeFile(
      resolve(mediaDirectory, storagePath),
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
      publishedRefCount: 0,
      refCount: 1,
    });
    await db.createDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl), {
      kind: 'media',
      provider: 'alibaba',
      sourceUrl,
      imageId: id,
    });
    ids.push(id);
  }
  // Simulate the explicit category/media attachment only. Never seed effective prices or a detail DTO.
  await db.update('products', draft.productId, {
    productFamily: 'misc',
    imageIds: ids.slice(0, gallery.length),
    descriptionImageIds: ids.slice(gallery.length),
  });
  const fobRaw = await readFile(new URL('./alibaba-fob-wire.json', import.meta.url), 'utf8');
  const fob = await seedRawObservation(db, fobRaw);
  await db.update('products', fob.draft.productId, { productFamily: 'misc' });
  const colorRaw = await readFile(
    new URL('./alibaba-variant-images-wire.json', import.meta.url),
    'utf8',
  );
  const color = await seedRawObservation(db, colorRaw);
  const colorGallery = color.observation.content.media.map((m) => m.sourceUrl);
  const colorSources = [
    ...colorGallery,
    ...color.observation.variants.flatMap((v) => v.media.map((m) => m.sourceUrl)),
  ];
  assert.equal(colorSources.length, 9);
  for (const [i, sourceUrl] of colorSources.entries()) {
    const id = `raw-color-image-${i}`;
    const storagePath = `${id}.png`;
    await writeFile(
      resolve(mediaDirectory, storagePath),
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
      publishedRefCount: 0,
      refCount: 1,
    });
    await db.createDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl), {
      kind: 'media',
      provider: 'alibaba',
      sourceUrl,
      imageId: id,
    });
  }
  await db.update('products', color.draft.productId, {
    productFamily: 'headphones',
    // This redacted fixture retains only the captured SKU/gallery wire shape.
    // Supply an explicit manual description to satisfy the normal publish gate.
    description: 'Disposable source color mapping acceptance fixture.',
    imageIds: colorGallery.map((_, i) => `raw-color-image-${i}`),
  });
}
