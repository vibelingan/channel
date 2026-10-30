import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { seedCatalogSeoRequests } from './catalog-seo-bootstrap.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';
const config = { siteOrigin: 'https://fixture.example', detailEnabled: true };
const now = '2026-10-30T00:00:00.000Z';
function fixture() {
  const rows = new Map<string, CollectionDoc>();
  const sizes: number[] = [];
  const store: CatalogSeoStore = {
    get: async (c, id) => rows.get(`${c}/${id}`) ?? null,
    list: async () => [],
    transaction: async (fn) => {
      let written = false;
      let n = 0;
      const result = await fn({
        get: async (c, id) => {
          assert.equal(written, false, 'all reads precede transaction writes');
          n++;
          return rows.get(`${c}/${id}`) ?? null;
        },
        set: async (c, row) => {
          assert.equal(c, 'catalogSeoRequests');
          written = true;
          n++;
          rows.set(`${c}/${row._id}`, structuredClone(row));
        },
      });
      sizes.push(n);
      return result;
    },
  };
  return { rows, sizes, store };
}
test('existing URLs are seeded in bounded transactions without business writes or duplicate IDs', async () => {
  const x = fixture();
  const ids = Array.from({ length: 137 }, (_, i) => `product-${i}`);
  const first = await seedCatalogSeoRequests(x.store, config, [...ids, 'product-0'], now);
  assert.equal(first.queued, 137);
  assert.ok(x.sizes.every((n) => n <= 60));
  const before = structuredClone(x.rows);
  const again = await seedCatalogSeoRequests(x.store, config, ids, now);
  assert.equal(again.preserved, 137);
  assert.deepEqual(x.rows, before);
});
test('an existing head and a newer pending request survive the bootstrap', async () => {
  const x = fixture();
  x.rows.set(`catalogPublicHeads/${catalogPublicRecordId(config.siteOrigin, 'tracked')}`, {
    _id: catalogPublicRecordId(config.siteOrigin, 'tracked'),
  });
  const newer = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'pending', previouslyPublic: true },
    '2026-10-30T01:00:00.000Z',
  );
  x.rows.set(`catalogSeoRequests/${newer._id}`, newer);
  const result = await seedCatalogSeoRequests(x.store, config, ['tracked', 'pending'], now);
  assert.equal(result.tracked, 1);
  assert.equal(result.preserved, 1);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${newer._id}`), newer);
});
test('a withdrawn accepted URL keeps its pending token and gains only the known-public flag', async () => {
  const x = fixture();
  const previous = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'withdrawn', previouslyPublic: false },
    now,
  );
  x.rows.set(`catalogSeoRequests/${previous._id}`, previous);
  const result = await seedCatalogSeoRequests(x.store, config, ['withdrawn'], now);
  assert.equal(result.upgraded, 1);
  assert.deepEqual(x.rows.get(`catalogSeoRequests/${previous._id}`), {
    ...previous,
    previouslyPublic: true,
  });
});
