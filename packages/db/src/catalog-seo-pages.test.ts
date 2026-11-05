import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import {
  type CatalogSeoPageDatabase,
  createCatalogSeoPageReader,
  createCloudCatalogSeoPageReader,
  readCatalogSeoPageOrigin,
} from './catalog-seo-pages.ts';
const site = 'https://shop.example';
const page = (productId: string) => ({
  _id: catalogPublicRecordId(site, productId),
  schemaVersion: 1,
  siteOrigin: site,
  productId,
  ready: true,
  sequence: 1,
  htmlSha256: 'a'.repeat(64),
  acceptedAt: '2026-10-30T00:00:00.000Z',
});
test('only owned, valid ready records mark a page ready', async () => {
  const reader = createCatalogSeoPageReader(site, async () => [
    page('p'),
    { ...page('foreign'), siteOrigin: 'https://other.example' },
    { ...page('broken'), htmlSha256: 'bad' },
  ]);
  const result = await reader.read(['p', 'foreign', 'broken', 'unknown']);
  assert.deepEqual(
    [...result],
    [
      ['p', true],
      ['foreign', false],
      ['broken', false],
      ['unknown', false],
    ],
  );
  await assert.rejects(reader.read(Array.from({ length: 49 }, (_, i) => `p${i}`)));
});
test('actual installed SDK uses one indexed query for the entire availability batch', async (t) => {
  const f = articleSdkFixture(t);
  const native: unknown = f.db;
  function valid(value: unknown): asserts value is CatalogSeoPageDatabase {
    assert.ok(value && typeof value === 'object');
    assert.equal(typeof Reflect.get(value, 'collection'), 'function');
    const command = Reflect.get(value, 'command');
    assert.ok(command && typeof command === 'object');
    assert.equal(typeof Reflect.get(command, 'in'), 'function');
  }
  valid(native);
  for (const id of ['a', 'b']) f.put('catalogSeoPages', catalogPublicRecordId(site, id), page(id));
  const result = await createCloudCatalogSeoPageReader(native, site).read(['a', 'b', 'missing']);
  assert.deepEqual(
    [...result],
    [
      ['a', true],
      ['b', true],
      ['missing', false],
    ],
  );
  assert.equal(f.calls.filter((c) => c.api === 'database.getDocument').length, 1);
  assert.equal(
    f.calls.some((c) => c.api === 'database.modifyDocument'),
    false,
  );
});

test('availability config requires an explicit matching HTTPS site and cannot silently accept a typo', () => {
  assert.equal(readCatalogSeoPageOrigin({}), undefined);
  assert.equal(readCatalogSeoPageOrigin({ CATALOG_SEO_PAGE_READINESS: '0' }), undefined);
  const valid = { CATALOG_SEO_PAGE_READINESS: '1', CATALOG_SEO_SITE_ORIGIN: site };
  assert.equal(readCatalogSeoPageOrigin(valid), site);
  for (const invalid of [
    { ...valid, CATALOG_SEO_PAGE_READINESS: 'yes' },
    { ...valid, CATALOG_SEO_SITE_ORIGIN: 'http://shop.example' },
    { ...valid, SITE_URL: 'https://wrong.example' },
  ])
    assert.throws(() => readCatalogSeoPageOrigin(invalid));
});
test('duplicate database identities cannot mark a page ready', async () => {
  await assert.rejects(
    createCatalogSeoPageReader(site, async () => [page('p'), page('p')]).read(['p', 'q']),
    /identities/,
  );
});
