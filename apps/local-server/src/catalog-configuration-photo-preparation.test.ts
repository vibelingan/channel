import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  sourceMediaLinkId,
  sourceObservationDocumentId,
} from '@vibelingan-channel/catalog-import/observations';
import { manageCatalogDetailApproval, setAdapter } from '@vibelingan-channel/db';
import { approveInOneRequest } from '../../functions/admin/src/catalog-approve-once.ts';
import {
  readAlibabaDetailPlan,
  sourceVariantIds,
} from '../../functions/admin/src/catalog-detail-source.ts';
import { inspectCatalogPreparation } from '../../functions/admin/src/catalog-preparation-inspect.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { fixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { prepareAlibabaPhotosPage } from '../../functions/alibaba-catalog-sync/src/photo-preparation.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import { JsonFileAdapter } from './json-adapter.ts';

function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-configuration-photo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { product, observation, adapter: seed } = fixture(205);
  Object.assign(product, {
    imageIds: ['image-owned'],
    descriptionImageIds: [],
    updatedAt: '2026-10-14T12:00:00.000Z',
    alibabaPhotosPending: true,
  });
  const urls = observation.variants.map((variant, i) => {
    const sourceUrl = `http://s.alibaba.com/config-${i}.png`;
    variant.media = [{ sourceUrl, position: 0, role: 'variant' }];
    return sourceUrl.replace('http:', 'https:');
  });
  const row = seed.rows.catalogSourceObservations?.[0];
  assert.ok(row);
  row.observation = observation;
  seed.rows.images = [
    {
      _id: 'image-owned',
      status: 'active',
      storageProvider: 'local-disk',
      publishedRefCount: 0,
      refCount: 1,
    },
  ];
  const path = join(directory, 'db.json');
  writeFileSync(path, JSON.stringify(seed.rows));
  const adapter = new JsonFileAdapter(path);
  setAdapter(adapter);
  return { adapter, product, observation, urls, path };
}

test('native photo preparation feeds all 205 independent configuration copies into complete inspection', async (t) => {
  const { adapter, product, urls, path } = workspace(t);
  const ids = new Map(urls.map((url, i) => [url, `copy-${i}`]));
  const copied: string[] = [];
  const prepared = await prepareAlibabaPhotosPage({
    budgetMs: 60000,
    importImage: async (sourceUrl) => {
      const imageId = ids.get(sourceUrl);
      assert.ok(imageId);
      copied.push(sourceUrl);
      await adapter.upsertDocWithId('images', imageId, {
        status: 'active',
        storageProvider: 'local-disk',
        publishedRefCount: 0,
      });
      await adapter.upsertDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl), {
        provider: 'alibaba',
        sourceUrl,
        imageId,
      });
      return { ok: true, imageId, deduplicated: false };
    },
  });
  assert.equal(prepared.prepared, 1);
  assert.equal(copied.length, 205);
  assert.equal(new Set(copied).size, 205);
  const beforeInspection = readFileSync(path, 'utf8');
  const result = await inspectCatalogPreparation(
    'admin',
    { productId: product._id },
    { budgetMs: 60000 },
  );
  assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
  assert.deepEqual(result.media, { scanned: 206, total: 206 });
  const saved = await adapter.get('products', product._id);
  assert.equal(saved?.published, false);
  assert.equal(saved?.productFamily, 'misc');
  const auto = saved?.alibabaAutoPhotos;
  assert.ok(auto && typeof auto === 'object');
  const marker: unknown = Reflect.get(auto, 'configurations');
  assert.ok(marker && typeof marker === 'object');
  assert.equal(Reflect.get(marker, 'sourceCount'), 205);
  assert.ok(Buffer.byteLength(JSON.stringify(marker)) < 256);
  // Independent large-media publication uses the P3 protocol; this case proves preparation/inspection only.
  assert.equal(readFileSync(path, 'utf8'), beforeInspection);
});

test('native last-photo failure, owned replacement, staged approval, publish/readback and withdrawal join correctly', async (t) => {
  const { adapter, product, observation, urls } = workspace(t);
  const last = urls.at(-1);
  assert.ok(last);
  const result = await prepareAlibabaPhotosPage({
    budgetMs: 60000,
    importImage: async (sourceUrl) => {
      if (sourceUrl === last) return { ok: false, reason: 'not-found' };
      // These source photos deliberately share a copied object. The preceding test uses 205 distinct objects.
      await adapter.upsertDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl), {
        provider: 'alibaba',
        sourceUrl,
        imageId: 'image-owned',
      });
      return { ok: true, imageId: 'image-owned', deduplicated: true };
    },
  });
  assert.equal(result.prepared, 1);
  const blocked = await inspectCatalogPreparation('admin', { productId: product._id });
  assert.ok(blocked.ok && blocked.outcome === 'blocked');
  assert.equal(blocked.issues[0]?.remedy, 'edit');
  const lastVariant = observation.variants.at(-1);
  assert.ok(lastVariant);
  const variantId = sourceVariantIds(product._id, 'read-source', observation).get(
    lastVariant.sourceVariantKey,
  );
  assert.ok(variantId);
  const config = { jwtSecret: 'configuration-photo-local-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const update = (values: Record<string, unknown>, expectedUpdatedAt?: string) =>
    handleAdminRequest(
      {
        action: 'update',
        token,
        data: {
          collection: 'products',
          id: product._id,
          values,
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        },
      },
      config,
    );
  const before = await adapter.get('products', product._id);
  assert.equal(typeof before?.updatedAt, 'string');
  if (typeof before?.updatedAt !== 'string') throw new Error('missing native product revision');
  assert.equal(
    (await update({ configurationPhotos: { [variantId]: ['image-owned'] } }, before.updatedAt)).ok,
    true,
  );
  const ready = await inspectCatalogPreparation('admin', { productId: product._id });
  assert.ok(ready.ok && ready.outcome === 'ready');
  const approved = await approveInOneRequest('admin', {
    action: 'approve',
    productId: product._id,
    operationId: randomUUID(),
  });
  assert.ok(approved.ok && approved.status === 'approved', JSON.stringify(approved));
  try {
    assert.equal((await update({ published: true })).ok, true);
    const ids: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const detail = await getProductDetail(product._id, page);
      assert.ok(detail.ok, JSON.stringify(detail));
      assert.equal(detail.data.variants.total, 205);
      ids.push(...detail.data.variants.items.map((variant) => variant.id));
      if (page === 5)
        assert.deepEqual(detail.data.variants.items.at(-1)?.images, ['/api/images/image-owned']);
    }
    assert.equal(ids.length, 205);
    assert.equal(new Set(ids).size, 205);
    assert.equal((await adapter.get('images', 'image-owned'))?.publishedRefCount, 1);
  } finally {
    assert.equal((await update({ published: false })).ok, true);
  }
  assert.equal((await adapter.get('products', product._id))?.published, false);
  assert.equal((await adapter.get('products', product._id))?.productFamily, 'misc');
  assert.equal((await adapter.get('images', 'image-owned'))?.publishedRefCount, 0);
  assert.equal((await getProductDetail(product._id, 1)).ok, false);
});

test('native unavailable observation preserves its existing completion summary without copying or saving', async (t) => {
  const { adapter, product, path } = workspace(t);
  const prepared = await prepareAlibabaPhotosPage({
    budgetMs: 60000,
    importImage: async (sourceUrl) => {
      await adapter.upsertDocWithId('catalogSourceLinks', sourceMediaLinkId('alibaba', sourceUrl), {
        provider: 'alibaba',
        sourceUrl,
        imageId: 'image-owned',
      });
      return { ok: true, imageId: 'image-owned', deduplicated: true };
    },
  });
  assert.equal(prepared.prepared, 1);
  assert.equal(
    await adapter.remove(
      'catalogSourceObservations',
      sourceObservationDocumentId('alibaba', 'read-source'),
    ),
    true,
  );
  const before = readFileSync(path, 'utf8');
  let calls = 0;
  const page = await prepareAlibabaPhotosPage({
    retryUnavailable: true,
    importImage: async () => {
      calls++;
      return { ok: false, reason: 'fetch-failed' };
    },
  });
  assert.equal(page.prepared, 0);
  assert.equal(calls, 0);
  assert.equal(readFileSync(path, 'utf8'), before);
  const inspection = await inspectCatalogPreparation('admin', { productId: product._id });
  assert.ok(inspection.ok && inspection.outcome !== 'ready');
  assert.equal(inspection.previewReady, false);
});

test('native approval replaces old raw-prefix preparation when website photo order is already complete', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-photo-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { product, observation, adapter: seed } = fixture(1);
  product.updatedAt = '2026-10-14T12:00:00.000Z';
  product.imageIds = ['position-1'];
  const variant = observation.variants[0];
  const stored = seed.rows.catalogSourceObservations?.[0];
  assert.ok(variant && stored);
  const url = (i: number) => `https://s.alibaba.com/position-${i}.png`;
  variant.media = Array.from({ length: 10 }, (_, i) => ({
    sourceUrl: url(i),
    role: 'variant',
    position: 9 - i,
  }));
  stored.observation = observation;
  seed.rows.catalogSourceLinks = Array.from({ length: 9 }, (_, offset) => {
    const i = offset + 1;
    return {
      _id: sourceMediaLinkId('alibaba', url(i)),
      provider: 'alibaba',
      sourceUrl: url(i),
      imageId: `position-${i}`,
    };
  });
  seed.rows.images = Array.from({ length: 9 }, (_, offset) => ({
    _id: `position-${offset + 1}`,
    status: 'active',
    storageProvider: 'local-disk',
    publishedRefCount: 0,
  }));
  const path = join(directory, 'db.json');
  writeFileSync(path, JSON.stringify(seed.rows));
  const adapter = new JsonFileAdapter(path);
  setAdapter(adapter);
  const current = await readAlibabaDetailPlan(product._id, product, 0, 20);
  assert.ok(current.ok);
  const id = current.packet.variantIds[0];
  assert.ok(id);
  // Captured from the actual pre-fix module at24e10e7, with exactly this observation and bindings.
  const legacyRevision = 'a1b4a8ab5814a7d69750aa51463bc49ae27c55b1fe6eac2bae9a98894bc5e3c9';
  const legacy = await adapter.persistCatalogDetailApproval('admin', {
    ...current.packet,
    action: 'source-page',
    revision: legacyRevision,
    variantMedia: [
      { id, sources: Array.from({ length: 9 }, (_, i) => url(i)), unboundSources: [url(0)] },
    ],
  });
  assert.ok(legacy.ok);
  const oldReview = await manageCatalogDetailApproval('admin', {
    action: 'review',
    productId: product._id,
    includePreviewMedia: true,
    includeMediaSummary: true,
  });
  assert.ok(oldReview.ok && 'previewMedia' in oldReview);
  const media = oldReview.previewMedia;
  assert.ok(media && typeof media === 'object');
  assert.equal(Reflect.get(media, 'allVariantsBound'), false);
  const approved = await approveInOneRequest('admin', {
    action: 'approve',
    productId: product._id,
    operationId: randomUUID(),
  });
  assert.ok(approved.ok && approved.status === 'approved', JSON.stringify(approved));
  const saved = await adapter.get('products', product._id);
  assert.notEqual(saved?.detailSourceRevision, legacyRevision);
  assert.deepEqual((await adapter.get('productVariants', id))?.detailSourceUnboundMediaSources, []);
  const config = { jwtSecret: 'photo-order-local-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const visibility = (published: boolean) =>
    handleAdminRequest(
      {
        action: 'update',
        token,
        data: { collection: 'products', id: product._id, values: { published } },
      },
      config,
    );
  try {
    const published = await visibility(true);
    assert.ok(published.ok, JSON.stringify(published));
    const detail = await getProductDetail(product._id, 1);
    assert.ok(detail.ok);
    assert.deepEqual(
      detail.data.variants.items[0]?.images,
      Array.from({ length: 9 }, (_, i) => `/api/images/position-${9 - i}`),
    );
  } finally {
    assert.equal((await visibility(false)).ok, true);
  }
  for (let i = 1; i <= 9; i++)
    assert.equal((await adapter.get('images', `position-${i}`))?.publishedRefCount, 0);
});
