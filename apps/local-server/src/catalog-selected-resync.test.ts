import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { matchesCatalogReadiness } from '../../../packages/db/src/catalog-readiness-query.ts';
import { syncSelectedAlibabaProduct } from '../../functions/alibaba-catalog-sync/src/selected-sync.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const externalId = 'selected-resync-fixture';
const now = '2026-10-20T00:00:00.000Z';
function body(title: string, id = externalId) {
  return JSON.stringify({
    alibaba_icbu_product_get_response: {
      product: {
        product_id: id,
        subject: title,
        description: '<p>Provider description</p>',
        category_id: 123,
        status: 'published',
        sourcing_trade: {
          fob_currency: 'USD',
          fob_min_price: '12.34',
          fob_max_price: '12.34',
          min_order_quantity: '3',
        },
      },
    },
  });
}

for (const state of ['unclassified', 'classified', 'live'] as const) {
  test(`selected resync twice retains identity, curated fields and ${state} status in a reopened JSON database`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'channel-selected-resync-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'db.json');
    let database = new JsonFileAdapter(file);
    setAdapter(database);
    setMediaStorage(new LocalDiskMediaStorage(join(directory, 'media')));
    let response = body('First provider title');
    let calls = 0;
    const sync = () =>
      syncSelectedAlibabaProduct({
        sourceProductId: externalId,
        deps: {
          now: () => now,
          getAccessToken: async () => ({ ok: true, accessToken: 'synthetic-token' }),
          client: {
            fingerprintFor: () => 'synthetic-fingerprint',
            callApi: async (request) => {
              calls++;
              assert.equal(request.params?.product_id, externalId);
              assert.equal(request.timeoutMs, 5000);
              assert.equal(request.maxAttempts, 1);
              return { ok: true, status: 200, bodyText: response };
            },
          },
        },
      });
    const first = await sync();
    assert.ok(first.ok);
    const protectedValues = {
      name: 'Curated title',
      description: 'Curated description',
      productFamily: state === 'unclassified' ? null : 'misc',
      subcategoryIds: state === 'unclassified' ? [] : ['existing-clock'],
      imageIds: ['curated-photo'],
      descriptionImageIds: ['curated-description-photo'],
      unitPrice: 23,
      catalogPricingMode: 'manual',
      manualCatalogPricing: { mode: 'fixed', currency: 'USD', amountMinor: 2300 },
      published: state === 'live',
      archived: false,
    };
    await database.update('products', first.productId, protectedValues);
    await database.create('products', { _id: 'other-live', name: 'Other live', published: true });
    await database.create('images', {
      _id: 'curated-photo',
      status: 'active',
      refCount: 2,
      publishedRefCount: state === 'live' ? 2 : 1,
    });
    const other = await database.get('products', 'other-live');
    const image = await database.get('images', 'curated-photo');
    const before = await database.get('products', first.productId);
    assert.ok(before);
    response = body('Changed provider title');
    for (let attempt = 0; attempt < 2; attempt++) {
      database = new JsonFileAdapter(file);
      setAdapter(database);
      const result = await sync();
      assert.ok(result.ok);
      assert.equal(result.productId, first.productId);
      assert.equal(result.draftCreated, false);
      const product = await database.get('products', first.productId);
      assert.ok(product);
      for (const [key, value] of Object.entries(protectedValues))
        assert.deepEqual(product[key], value, `${key} must survive resync`);
      assert.ok(Number(product.catalogContentGeneration) > Number(before.catalogContentGeneration));
      assert.equal(product.catalogPreparationState, 'stale');
      assert.equal(
        matchesCatalogReadiness(product, state === 'live' ? 'normal' : 'unchecked'),
        true,
      );
      assert.deepEqual(await database.get('products', 'other-live'), other);
      assert.deepEqual(await database.get('images', 'curated-photo'), image);
      assert.equal(
        (await database.list({ collection: 'products', page: 1, pageSize: 100, search: '' })).total,
        2,
      );
      assert.equal(
        (
          await database.list({
            collection: 'alibabaProductLinks',
            page: 1,
            pageSize: 100,
            search: '',
          })
        ).total,
        1,
      );
    }
    const settled = await database.get('products', first.productId);
    response = body('Wrong provider identity', 'another-product');
    const rejected = await sync();
    assert.deepEqual(rejected, { ok: false, reason: 'product-id-mismatch' });
    assert.deepEqual(await database.get('products', first.productId), settled);
    assert.deepEqual(await database.get('products', 'other-live'), other);
    assert.deepEqual(await database.get('images', 'curated-photo'), image);
    const lease = await database.get('alibabaSyncLeases', 'primary');
    assert.ok(lease?.releasedAt);
    assert.equal(calls, 4);
  });
}
