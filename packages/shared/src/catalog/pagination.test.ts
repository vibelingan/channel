import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogVariantCapacityIssues } from './detail-approval.ts';
import {
  CATALOG_DETAIL_PAGE_MAX_BYTES,
  planCatalogDetailPagination,
  readCatalogDetailPageSize,
} from './pagination.ts';
import { CatalogDetailHeaderSchema, CatalogDetailVariantSchema } from './product-detail.ts';

const header = CatalogDetailHeaderSchema.parse({
  schemaVersion: 'catalog-product-detail-v1',
  _id: 'p',
  name: 'Clock',
  images: [],
  facts: [],
  offers: [],
});
const variant = (id: string, value = 'small') =>
  CatalogDetailVariantSchema.parse({
    id,
    images: [],
    offers: [],
    inventory: { state: 'unknown' },
    options: [{ name: 'Option', value }],
  });
for (const count of [0, 20, 105, 10000])
  test(`ordinary ${count} configurations retain fifty-wide paging`, () => {
    const variants = Array.from({ length: count }, (_, i) => variant(`v${i}`));
    const result = planCatalogDetailPagination({ header }, variants);
    assert.equal(result.pageSize, 50);
    assert.ok(result.singlePageFits);
  });

for (const text of [
  '中'.repeat(1000),
  String.fromCharCode(34, 92).repeat(600),
  String.fromCharCode(1).repeat(500),
]) {
  test(`complete later large configuration controls every page width: ${text.charCodeAt(0)}`, () => {
    const variants = Array.from({ length: 105 }, (_, i) => variant(`v${i}`));
    variants[104] = CatalogDetailVariantSchema.parse({
      ...variant('v104'),
      options: Array.from({ length: 42 }, (_, i) => ({ name: `Option ${i}`, value: text })),
    });
    assert.deepEqual(catalogVariantCapacityIssues(variants), []);
    const before = JSON.stringify(variants);
    const result = planCatalogDetailPagination({ header }, variants);
    assert.ok(result.pageSize < 50);
    assert.ok(result.singlePageFits);
    const seen = [];
    for (let offset = 0; offset < variants.length; offset += result.pageSize) {
      const items = variants.slice(offset, offset + result.pageSize);
      const response = {
        ok: true,
        data: {
          ...header,
          revision: 'r',
          variants: {
            items,
            total: variants.length,
            page: offset / result.pageSize + 1,
            pageSize: result.pageSize,
            hasMore: offset + result.pageSize < variants.length,
          },
        },
      };
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= CATALOG_DETAIL_PAGE_MAX_BYTES);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
            isBase64Encoded: false,
          }),
        ) < 5_000_000,
      );
      seen.push(...items);
    }
    assert.deepEqual(seen, variants);
    assert.equal(JSON.stringify(variants), before);
  });
}

test('preview media metadata is counted even when configurations themselves are small', () => {
  const variants = Array.from({ length: 50 }, (_, i) => variant(`v${i}`));
  const sources = Array.from(
    { length: 9 },
    (_, i) => `https://sc04.alicdn.com/${i}?${'a'.repeat(10000)}`,
  );
  const media = {
    galleryIds: [],
    descriptionIds: [],
    gallerySources: [],
    descriptionSources: [],
    variantSources: variants.map((v) => ({ id: v.id, sources, unboundSources: sources })),
  };
  const result = planCatalogDetailPagination({ header }, variants, media);
  assert.ok(result.pageSize < 50);
  assert.ok(result.singlePageFits);
  for (let offset = 0; offset < variants.length; offset += result.pageSize) {
    const page = {
      ok: true,
      data: {
        detail: {
          ...header,
          variants: {
            items: variants.slice(offset, offset + result.pageSize),
            total: variants.length,
            page: offset / result.pageSize + 1,
            pageSize: result.pageSize,
            hasMore: offset + result.pageSize < variants.length,
          },
        },
        previewMedia: {
          ...media,
          variantSources: media.variantSources.slice(offset, offset + result.pageSize),
        },
      },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CATALOG_DETAIL_PAGE_MAX_BYTES);
  }
});

test('an unsplittable oversized media value is reported without truncation or invented bindings', () => {
  const source = `https://sc04.alicdn.com/?${'a'.repeat(CATALOG_DETAIL_PAGE_MAX_BYTES)}`;
  const media = {
    galleryIds: [],
    descriptionIds: [],
    gallerySources: [source],
    descriptionSources: [],
    variantSources: [],
  };
  const result = planCatalogDetailPagination({ header }, [], media);
  assert.equal(result.singlePageFits, false);
  assert.ok(result.pageBytesBound > CATALOG_DETAIL_PAGE_MAX_BYTES);
  assert.equal(media.gallerySources[0], source);
});

test('private paging hints are bound to current revision and policy', () => {
  assert.equal(readCatalogDetailPageSize({}, 'r'), 50);
  const hint = { policyVersion: 'catalog-detail-pagination-v1', revision: 'r', pageSize: 10 };
  assert.equal(readCatalogDetailPageSize({ catalogDetailPagination: hint }, 'r'), 10);
  for (const bad of [
    { ...hint, revision: 'other' },
    { ...hint, policyVersion: 'old' },
    { ...hint, pageSize: 0 },
    { ...hint, pageSize: 51 },
    { ...hint, pageSize: '10' },
    { ...hint, privateExtra: 'no' },
  ])
    assert.equal(readCatalogDetailPageSize({ catalogDetailPagination: bad }, 'r'), null);
});

test('fifty full multibyte configurations obey the actual JSON byte bound on every page', () => {
  const variants = Array.from({ length: 50 }, (_, index) =>
    CatalogDetailVariantSchema.parse({
      ...variant(`wide-${index}`),
      options: Array.from({ length: 42 }, (_, i) => ({
        name: `Option ${i}`,
        value: '中'.repeat(1000),
      })),
    }),
  );
  assert.deepEqual(catalogVariantCapacityIssues(variants), []);
  const result = planCatalogDetailPagination({ header }, variants);
  for (let offset = 0; offset < variants.length; offset += result.pageSize) {
    const body = JSON.stringify({
      ok: true,
      data: {
        ...header,
        revision: 'r',
        variants: {
          items: variants.slice(offset, offset + result.pageSize),
          total: 50,
          page: offset / result.pageSize + 1,
          pageSize: result.pageSize,
          hasMore: offset + result.pageSize < 50,
        },
      },
    });
    assert.ok(Buffer.byteLength(body) <= result.pageBytesBound);
    assert.ok(Buffer.byteLength(body) <= CATALOG_DETAIL_PAGE_MAX_BYTES);
  }
});
