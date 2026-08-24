import { strict as assert } from 'node:assert';
import test from 'node:test';
import { z } from 'zod';
import { CatalogPageSchema, PublicProductSchema, catalogPageSchema } from './index.ts';

/**
 * The oldest Headphones DTO predates the explicit `productFamily` column and is
 * recognized through its legacy category; the canonical family is resolved
 * BEFORE this schema runs (see productFamilyForDoc in the normalizer). Every
 * real family keeps a current DTO carrying only the required keys.
 */
const oldestHeadphones = {
  _id: 'hp-legacy-1',
  name: 'Legacy Wired Headphones',
  productFamily: 'headphones',
  category: 'wired',
} as const;

const currentDtosByFamily = [
  { _id: 'hp-1', name: 'Office Headphones', productFamily: 'headphones', category: 'office' },
  { _id: 'ag-1', name: 'Smart Speaker', productFamily: 'ai-gadgets' },
  { _id: 'toy-1', name: 'RC Speed Car', productFamily: 'toys' },
  { _id: 'misc-1', name: 'Cable Organizer', productFamily: 'misc' },
] as const;

test('parses the oldest Headphones DTO and one current DTO per real family without optional fields', () => {
  assert.equal(PublicProductSchema.safeParse(oldestHeadphones).success, true);
  for (const dto of currentDtosByFamily) {
    const result = PublicProductSchema.safeParse(dto);
    assert.equal(result.success, true, `family ${dto.productFamily} should parse`);
    if (result.success) {
      assert.equal(result.data._id, dto._id);
      assert.equal(result.data.name, dto.name);
      assert.equal(result.data.productFamily, dto.productFamily);
    }
  }
});

test('requires _id, name, and a canonical productFamily', () => {
  const base = { _id: 'p-1', name: 'Product', productFamily: 'toys' } as const;
  const cases: Array<[string, unknown]> = [
    ['missing _id', { name: base.name, productFamily: base.productFamily }],
    ['empty _id', { _id: '', name: base.name, productFamily: base.productFamily }],
    ['missing name', { _id: base._id, productFamily: base.productFamily }],
    ['empty name', { _id: base._id, name: '  ', productFamily: base.productFamily }],
    ['missing productFamily', { _id: base._id, name: base.name }],
    ['non-canonical family', { ...base, productFamily: 'gadgets' }],
    ['_id wrong type', { _id: 7, name: base.name, productFamily: base.productFamily }],
  ];
  for (const [label, dto] of cases) {
    assert.equal(PublicProductSchema.safeParse(dto).success, false, label);
  }
});

test('rejects unknown and role-gated/private keys', () => {
  const base = { _id: 'p-1', name: 'Product', productFamily: 'toys' } as const;
  const cases: Array<[string, unknown]> = [
    ['vipPrice is role-gated', { ...base, vipPrice: 8 }],
    ['imageIds stays server-side', { ...base, imageIds: ['img-1'] }],
    ['alibabaPrimaryOfferKey never ships', { ...base, alibabaPrimaryOfferKey: 'x'.repeat(64) }],
    ['sourceOfferKey is stripped', { ...base, sourceOfferKey: 'offer-1' }],
    ['arbitrary unknown key', { ...base, hacker: 'x' }],
  ];
  for (const [label, dto] of cases) {
    assert.equal(PublicProductSchema.safeParse(dto).success, false, label);
  }
});

test('parses public scalar and pricing fields when present', () => {
  const dto = {
    _id: 'hp-1',
    name: 'Office Headphones',
    productFamily: 'headphones',
    category: 'office',
    series: 'Pro',
    modName: 'OP-200',
    modType: 'Over-ear',
    description: 'ANC office headset.',
    productCode: 'OP-200-BLK',
    skuCode: 'op-200-blk',
    slug: 'office-headphones-op-200',
    moq: 100,
    inventory: 2500,
    unitPrice: 12.5,
    wholesalePrice: 10,
    clearancePrice: 9,
    published: true,
    images: ['/api/images/img-1'],
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 1, unitAmountMinor: 1250 }],
    },
    alibabaPrimarySourceKey: 'linked',
    alibabaCatalogPricing: {
      schemaVersion: 'alibaba-catalog-pricing-v1',
      source: 'alibaba',
      currency: 'USD',
      mode: 'fixed',
      amountMinor: 1250,
      syncedAt: '2026-08-06T12:00:00.000Z',
    },
    alibabaSourceStatus: 'available',
    alibabaSourceLastSyncedAt: '2026-08-06T12:00:00.000Z',
  } as const;
  const result = PublicProductSchema.safeParse(dto);
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('rejects malformed optional and nested pricing fields', () => {
  const base = { _id: 'p-1', name: 'Product', productFamily: 'toys' } as const;
  const cases: Array<[string, unknown]> = [
    ['negative moq', { ...base, moq: -1 }],
    ['non-integer inventory', { ...base, inventory: 1.5 }],
    ['negative unitPrice', { ...base, unitPrice: -0.5 }],
    ['images not an array', { ...base, images: 'img-1' }],
    [
      'manualCatalogPricing unknown key',
      {
        ...base,
        manualCatalogPricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
          extra: true,
        },
      },
    ],
    [
      'alibabaCatalogPricing bad mode',
      {
        ...base,
        alibabaCatalogPricing: {
          schemaVersion: 'alibaba-catalog-pricing-v1',
          source: 'alibaba',
          mode: 'auction',
          syncedAt: '2026-08-06T12:00:00.000Z',
        },
      },
    ],
  ];
  for (const [label, dto] of cases) {
    assert.equal(PublicProductSchema.safeParse(dto).success, false, label);
  }
});

test('CatalogPageSchema parses a valid envelope', () => {
  const envelope = {
    items: [currentDtosByFamily[0], currentDtosByFamily[1]],
    total: 2,
    page: 1,
    pageSize: 48,
  } as const;
  const result = CatalogPageSchema.safeParse(envelope);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.total, 2);
    assert.equal(result.data.page, 1);
    assert.equal(result.data.pageSize, 48);
  }
});

test('CatalogPageSchema rejects malformed and unknown envelope fields', () => {
  const good = {
    items: [currentDtosByFamily[0]],
    total: 1,
    page: 1,
    pageSize: 48,
  } as const;
  const cases: Array<[string, unknown]> = [
    ['missing items', { total: 1, page: 1, pageSize: 48 }],
    ['missing total', { items: good.items, page: 1, pageSize: 48 }],
    ['negative total', { ...good, total: -1 }],
    ['page zero', { ...good, page: 0 }],
    ['missing pageSize', { items: good.items, total: 1, page: 1 }],
    ['pageSize zero', { ...good, pageSize: 0 }],
    ['unknown envelope key', { ...good, nextCursor: 'abc' }],
    ['item fails product schema', { ...good, items: [{ _id: 'x', name: 'y' }] }],
  ];
  for (const [label, dto] of cases) {
    assert.equal(CatalogPageSchema.safeParse(dto).success, false, label);
  }
});

test('catalogPageSchema is a generic factory over any item schema', () => {
  const idPage = catalogPageSchema(z.object({ id: z.string() }).strict());
  assert.equal(
    idPage.safeParse({ items: [{ id: 'a' }], total: 1, page: 1, pageSize: 10 }).success,
    true,
  );
  assert.equal(
    idPage.safeParse({ items: [{ id: 'a', extra: 1 }], total: 1, page: 1, pageSize: 10 }).success,
    false,
    'item schema strictness is preserved',
  );
});
