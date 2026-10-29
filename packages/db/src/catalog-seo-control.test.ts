import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CatalogSeoWriteBusyError,
  idleCatalogSeoControl,
  planCatalogSeoWrite,
} from './catalog-seo-control.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';
const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
const now = '2026-10-30T00:00:00.000Z';
const product = { _id: 'p', published: true, name: 'A' };
const request = createCatalogSeoRequest(
  config.siteOrigin,
  { kind: 'product', productId: 'p', previouslyPublic: true },
  now,
);
const tx = (control: ReturnType<typeof idleCatalogSeoControl> | null) => ({
  get: async () => control,
  set: async () => {},
});
test('only affected public writes wait during delivery; expiry never silently unlocks unknown operations', async () => {
  const active = {
    ...idleCatalogSeoControl(config.siteOrigin, now),
    state: 'needs-readback' as const,
    owner: 'job',
    until: '2026-10-29T00:00:00.000Z',
    products: ['p'],
    fence: 1,
  };
  await assert.rejects(
    planCatalogSeoWrite(tx(active), config, [], [request], now),
    CatalogSeoWriteBusyError,
  );
  const other = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'other', previouslyPublic: true },
    now,
  );
  assert.ok(await planCatalogSeoWrite(tx(active), config, [], [other], now));
  assert.equal(await planCatalogSeoWrite(tx(active), config, [], [], now), undefined);
});
test('publication and withdrawal atomically invalidate independent-page availability, ordinary edits do not', async () => {
  for (const before of [null, { ...product, published: false }, product]) {
    const after = before === product ? { ...product, published: false } : product;
    const permit = await planCatalogSeoWrite(
      tx(null),
      config,
      [{ collection: 'products', before, after }],
      [request],
      now,
    );
    assert.equal(permit?.pages[0]?.ready, false);
  }
  const edit = await planCatalogSeoWrite(
    tx(null),
    config,
    [{ collection: 'products', before: product, after: { ...product, name: 'B' } }],
    [request],
    now,
  );
  assert.deepEqual(edit?.pages, []);
  assert.equal(edit?.control.writes, 1);
});
