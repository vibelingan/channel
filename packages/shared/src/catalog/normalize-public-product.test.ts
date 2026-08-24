import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normalizePublicProduct } from './normalize-public-product.ts';

test('normalizes a frozen oldest Headphones row without mutation and keeps it _id detail-capable', () => {
  const row = Object.freeze({
    _id: 'hp-legacy-1',
    name: 'Legacy Wired Headphones',
    category: 'wired', // legacy category, no explicit productFamily
    series: 'Heritage',
    unitPrice: 9.5,
    vipPrice: 7, // role-gated, must be stripped
    imageIds: ['img-1'], // server-side, must be stripped
  });
  const result = normalizePublicProduct(row);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  // canonical family inferred from the legacy category
  assert.equal(result.value.productFamily, 'headphones');
  assert.equal(result.value.category, 'wired');
  // `_id` preserved -> remains detail-capable
  assert.equal(result.value._id, 'hp-legacy-1');
  // public optional fields carried through
  assert.equal(result.value.series, 'Heritage');
  assert.equal(result.value.unitPrice, 9.5);
  // private/server-side fields are stripped, never normalized into the public shape
  assert.equal('vipPrice' in result.value, false);
  assert.equal('imageIds' in result.value, false);
  // the inference is surfaced as a diagnostic, not silent
  assert.ok(
    result.diagnostics.some((d) => d.code === 'inferred-family-from-legacy-category'),
    'expected inferred-family diagnostic',
  );
  // immutability: the source row is untouched (no family added, private fields intact)
  assert.equal('productFamily' in row, false);
  assert.equal(row.vipPrice, 7);
  assert.deepEqual(row.imageIds, ['img-1']);
});

test('rejects an explicit invalid productFamily (fail-closed)', () => {
  const result = normalizePublicProduct({ _id: 'p-1', name: 'Gadget', productFamily: 'gadgets' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (issue) => issue.field === 'productFamily' && issue.code === 'invalid-family',
    ),
    JSON.stringify(result.issues),
  );
});

test('drops a stale legacy category on non-Headphones rows', () => {
  const result = normalizePublicProduct({
    _id: 'ag-1',
    name: 'Smart Speaker',
    productFamily: 'ai-gadgets',
    category: 'wired', // stale: subcategory applies only to Headphones
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.equal(result.value.productFamily, 'ai-gadgets');
  assert.equal('category' in result.value, false);
  assert.ok(
    result.diagnostics.some((d) => d.code === 'dropped-stale-legacy-category'),
    'expected dropped-category diagnostic',
  );
});

test('keeps a recognized legacy category on an explicit Headphones row with no inference diagnostic', () => {
  const result = normalizePublicProduct({
    _id: 'hp-2',
    name: 'Office Headphones',
    productFamily: 'headphones',
    category: 'office',
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.equal(result.value.category, 'office');
  assert.equal(result.diagnostics.length, 0);
});

test('rejects a row with no determinable canonical family (fail-closed)', () => {
  for (const row of [
    { _id: 'p-1', name: 'No family' }, // missing family, no legacy category
    { _id: 'p-2', name: 'Unknown category', category: 'furniture' }, // non-legacy category
  ]) {
    const result = normalizePublicProduct(row);
    assert.equal(result.ok, false, JSON.stringify(row));
    if (result.ok) continue;
    assert.ok(
      result.issues.some((issue) => issue.field === 'productFamily'),
      JSON.stringify(result.issues),
    );
  }
});

test('rejects rows that fail the public schema (fail-closed)', () => {
  for (const [label, row] of [
    ['missing _id', { name: 'X', productFamily: 'toys' }],
    ['empty name', { _id: 'p-1', name: '  ', productFamily: 'toys' }],
    ['negative moq', { _id: 'p-1', name: 'X', productFamily: 'toys', moq: -1 }],
    ['not an object', null],
    ['an array', []],
  ] as const) {
    const result = normalizePublicProduct(row);
    assert.equal(result.ok, false, label);
  }
});

test('Admin/write-only and unknown keys are never normalized into the public shape', () => {
  const result = normalizePublicProduct({
    _id: 'toy-1',
    name: 'RC Car',
    productFamily: 'toys',
    archived: false, // write contract field
    vipPrice: 5, // role-gated
    hacker: 'x', // unknown
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.equal('archived' in result.value, false);
  assert.equal('vipPrice' in result.value, false);
  assert.equal('hacker' in result.value, false);
});

test('does not mutate the source row when copying nested public fields', () => {
  const row = {
    _id: 'hp-1',
    name: 'Office Headphones',
    productFamily: 'headphones',
    images: ['/api/images/a'],
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 1, unitAmountMinor: 1250 }],
    },
  };
  const result = normalizePublicProduct(row);
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  assert.notEqual(result.value.images, row.images);
  assert.notEqual(result.value.manualCatalogPricing, row.manualCatalogPricing);
  assert.notEqual(result.value.manualCatalogPricing?.tiers, row.manualCatalogPricing.tiers);

  result.value.images?.push('/api/images/b');
  result.value.manualCatalogPricing?.tiers.push({ minQuantity: 2, unitAmountMinor: 1000 });

  assert.deepEqual(row.images, ['/api/images/a']);
  assert.deepEqual(row.manualCatalogPricing.tiers, [{ minQuantity: 1, unitAmountMinor: 1250 }]);
  assert.deepEqual(result.value.images, ['/api/images/a', '/api/images/b']);
  assert.equal(result.value.manualCatalogPricing?.tiers.length, 2);
  assert.equal(result.value.productFamily, 'headphones');
});

test('normalizes an alibaba-linked row, stripping supplier offer keys and masking the source key', () => {
  const result = normalizePublicProduct({
    _id: 'ab-1',
    name: 'Alibaba Earbuds',
    productFamily: 'headphones',
    category: 'bluetooth',
    alibabaPrimarySourceKey: 'a'.repeat(64),
    alibabaCatalogPricing: {
      schemaVersion: 'alibaba-catalog-pricing-v1',
      source: 'alibaba',
      currency: 'USD',
      mode: 'fixed',
      amountMinor: 250,
      sourceMoq: 100,
      sourceOfferKey: 'secret-offer',
      sourceProductId: 'secret-pid',
      sourceSkuId: 'secret-sku',
      syncedAt: '2026-08-06T12:00:00.000Z',
    },
    alibabaSourceStatus: 'available',
    alibabaSourceLastSyncedAt: '2026-08-06T12:00:00.000Z',
  });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  if (!result.ok) return;
  // supplier offer identifiers are stripped, never shipped
  const pricing = result.value.alibabaCatalogPricing as Record<string, unknown>;
  assert.equal('sourceOfferKey' in pricing, false);
  assert.equal('sourceProductId' in pricing, false);
  assert.equal('sourceSkuId' in pricing, false);
  assert.equal(pricing.amountMinor, 250);
  // the brute-forceable source key is masked to a constant marker
  assert.equal(result.value.alibabaPrimarySourceKey, 'linked');
});
