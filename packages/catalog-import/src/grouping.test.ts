import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FINDING_CODES } from './findings.ts';
import { type SourceListing, countListings, groupListings } from './grouping.ts';
import { displayQuantity, reconcileInventory } from './inventory.ts';

let nextRow = 1;

function listing(overrides: Partial<SourceListing> = {}): SourceListing {
  nextRow += 1;
  return {
    rowNumber: nextRow,
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    storeKey: 'ShopA_MY',
    parentSku: 'P-1',
    sku: 'S-1',
    title: 'Bluetooth earbuds',
    attributes: {},
    optionValues: {},
    productMedia: [],
    sourceListingStatus: 'published',
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]) => findings.map((finding) => finding.code);

// --- inventory reconciliation -----------------------------------------------

test('a single reported quantity is the displayed quantity', () => {
  const resolution = reconcileInventory([{ quantity: 40, semantics: 'unknown', storeKey: 'A' }]);
  assert.equal(resolution.state, 'known');
  assert.equal(displayQuantity(resolution), 40);
});

test('stores that agree contribute the value ONCE, never summed', () => {
  // Four stores mirroring one warehouse of 40 units. Summing would advertise
  // 160 and oversell by 120.
  const resolution = reconcileInventory(
    ['A', 'B', 'C', 'D'].map((storeKey) => ({
      quantity: 40,
      semantics: 'unknown' as const,
      storeKey,
    })),
  );
  assert.equal(resolution.state, 'known');
  assert.equal(displayQuantity(resolution), 40);
  assert.equal(resolution.snapshots.length, 4, 'every store snapshot is preserved');
});

test('stores that disagree produce a conflict and no fabricated number', () => {
  const resolution = reconcileInventory([
    { quantity: 40, semantics: 'unknown', storeKey: 'A' },
    { quantity: 12, semantics: 'unknown', storeKey: 'B' },
  ]);
  assert.equal(resolution.state, 'conflict');
  assert.equal(displayQuantity(resolution), null);
  if (resolution.state === 'conflict') assert.deepEqual(resolution.quantities, [12, 40]);
  assert.equal(resolution.snapshots.length, 2);
});

test('no usable quantity means unknown, not zero', () => {
  assert.equal(reconcileInventory([]).state, 'unknown');
  assert.equal(displayQuantity(reconcileInventory([])), null);
  const negative = reconcileInventory([{ quantity: -3, semantics: 'unknown' }]);
  assert.equal(negative.state, 'unknown');
  assert.equal(negative.snapshots.length, 1, 'the bad snapshot is still shown to the operator');
});

test('zero is a real quantity, not a missing one', () => {
  const resolution = reconcileInventory([{ quantity: 0, semantics: 'unknown', storeKey: 'A' }]);
  assert.equal(resolution.state, 'known');
  assert.equal(displayQuantity(resolution), 0);
});

// --- grouping ---------------------------------------------------------------

test('the same parent SKU across stores becomes one product', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA' }),
    listing({ storeKey: 'ShopB' }),
    listing({ storeKey: 'ShopC' }),
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.parentSku, 'P-1');
});

test('the same SKU across stores does not create duplicate website variants', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA', sku: 'S-1' }),
    listing({ storeKey: 'ShopB', sku: 'S-1' }),
    listing({ storeKey: 'ShopC', sku: ' s-1 ' }),
  ]);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.variants.length, 1);
  // Every store's line is still there to look at.
  assert.equal(result.storeListings.length, 3);
});

test('different SKUs under one parent become sibling variants', () => {
  const result = groupListings([
    listing({ sku: 'S-1', optionValues: { Color: 'Black' } }),
    listing({ sku: 'S-2', optionValues: { Color: 'White' } }),
  ]);
  assert.equal(result.products.length, 1);
  assert.deepEqual(
    result.products[0]?.variants.map((variant) => variant.sku),
    ['S-1', 'S-2'],
  );
  assert.deepEqual(result.products[0]?.variants[1]?.optionValues, { Color: 'White' });
});

test('each store listing keeps its own price, stock, status and marketplace id', () => {
  const result = groupListings([
    listing({
      storeKey: 'ShopA',
      sourceRegularPrice: { amountMinor: 129900, currency: 'CNY' },
      quantity: 40,
      externalProductId: '111',
      sourceListingStatus: 'published',
    }),
    listing({
      storeKey: 'ShopB',
      sourceRegularPrice: { amountMinor: 139900, currency: 'CNY' },
      quantity: 40,
      sourceListingStatus: 'draft',
    }),
  ]);
  assert.equal(result.storeListings.length, 2);
  assert.equal(result.storeListings[0]?.sourceRegularPrice?.amountMinor, 129900);
  assert.equal(result.storeListings[1]?.sourceRegularPrice?.amountMinor, 139900);
  assert.equal(result.storeListings[0]?.externalProductId, '111');
  assert.equal(result.storeListings[1]?.externalProductId, undefined);
  assert.equal(result.storeListings[1]?.sourceListingStatus, 'draft');
  // Store-scoped source keys stay distinct even though the variant is one.
  assert.notEqual(
    result.storeListings[0]?.sourceVariantKey,
    result.storeListings[1]?.sourceVariantKey,
  );
});

test('repeated equal store stock reaches the variant as one quantity', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA', quantity: 40 }),
    listing({ storeKey: 'ShopB', quantity: 40 }),
  ]);
  const resolved = result.inventory[0]?.resolution;
  assert.equal(resolved?.state, 'known');
  assert.equal(displayQuantity(resolved as never), 40);
  assert.equal(result.products[0]?.variants[0]?.inventory.length, 2);
});

test('conflicting store stock is reported and left unresolved', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA', quantity: 40 }),
    listing({ storeKey: 'ShopB', quantity: 12 }),
  ]);
  assert.ok(codes(result.findings).includes(FINDING_CODES.INVENTORY_CONFLICT));
  assert.equal(result.inventory[0]?.resolution.state, 'conflict');
  // The product is still importable; only its count is withheld.
  assert.equal(result.products.length, 1);
});

test('a SKU listed under two parent SKUs is quarantined, not attached to one', () => {
  const result = groupListings([
    listing({ sku: 'S-9', parentSku: 'P-1' }),
    listing({ sku: 'S-9', parentSku: 'P-2', storeKey: 'ShopB' }),
  ]);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0]?.reason, 'parent-conflict');
  assert.ok(codes(result.findings).includes(FINDING_CODES.VARIANT_PARENT_CONFLICT));
  // Neither product page silently gains the contradictory variant.
  assert.deepEqual(result.products, []);
});

test('a SKU carrying two different brands is quarantined', () => {
  const result = groupListings([
    listing({ sku: 'S-9', brand: 'Acme' }),
    listing({ sku: 'S-9', brand: 'Globex', storeKey: 'ShopB' }),
  ]);
  assert.equal(result.quarantined[0]?.reason, 'brand-conflict');
  assert.ok(codes(result.findings).includes(FINDING_CODES.VARIANT_BRAND_CONFLICT));
});

test('a quarantined variant does not take its healthy siblings with it', () => {
  const result = groupListings([
    listing({ sku: 'S-ok', parentSku: 'P-1' }),
    listing({ sku: 'S-bad', parentSku: 'P-1' }),
    listing({ sku: 'S-bad', parentSku: 'P-2', storeKey: 'ShopB' }),
  ]);
  assert.equal(result.products.length, 1);
  assert.deepEqual(
    result.products[0]?.variants.map((variant) => variant.sku),
    ['S-ok'],
  );
});

test('a duplicated (store, SKU) line is reported and used once', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA', sku: 'S-1', quantity: 40 }),
    listing({ storeKey: 'ShopA', sku: 'S-1', quantity: 99 }),
  ]);
  assert.ok(codes(result.findings).includes(FINDING_CODES.ROW_DUPLICATE_STORE_VARIANT));
  assert.equal(result.storeListings.length, 1);
  assert.equal(result.inventory[0]?.resolution.state, 'known');
  assert.equal(displayQuantity(result.inventory[0]?.resolution as never), 40);
});

test('a draft source listing still produces a publishable candidate', () => {
  const result = groupListings([listing({ sourceListingStatus: 'draft' })]);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0]?.sourceListingStatus, 'draft');
});

test('one live store listing makes the family read as published', () => {
  const result = groupListings([
    listing({ storeKey: 'ShopA', sourceListingStatus: 'draft' }),
    listing({ storeKey: 'ShopB', sourceListingStatus: 'published' }),
  ]);
  assert.equal(result.products[0]?.sourceListingStatus, 'published');
});

test('product fields come from the first row that supplies them', () => {
  const result = groupListings([
    listing({ rowNumber: 10, title: 'First title' }),
    listing({ rowNumber: 11, title: 'Second title', brand: 'Acme', storeKey: 'ShopB' }),
  ]);
  assert.equal(result.products[0]?.title, 'First title');
  assert.equal(
    result.products[0]?.brand,
    'Acme',
    'a later row may fill a field the first left blank',
  );
});

test('product media are unioned across stores, deduplicated, order preserved', () => {
  const result = groupListings([
    listing({ productMedia: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] }),
    listing({ storeKey: 'ShopB', productMedia: ['https://cdn/b.jpg', 'https://cdn/c.jpg'] }),
  ]);
  assert.deepEqual(
    result.products[0]?.media.map((entry) => entry.sourceUrl),
    ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'],
  );
  assert.equal(result.products[0]?.media[0]?.role, 'primary');
  assert.equal(result.products[0]?.media[1]?.role, 'gallery');
});

test('a variant image is attributed to its own SKU', () => {
  const result = groupListings([listing({ sku: 'S-1', variantMedia: 'https://cdn/v.jpg' })]);
  const media = result.products[0]?.variants[0]?.media[0];
  assert.equal(media?.role, 'variant');
  assert.equal(media?.variantSku, 'S-1');
});

// --- counts -----------------------------------------------------------------

test('counts distinguish canonical entities from store-scoped ones', () => {
  const counts = countListings([
    listing({ storeKey: 'A', parentSku: 'P-1', sku: 'S-1', productMedia: ['https://cdn/1.jpg'] }),
    listing({ storeKey: 'B', parentSku: 'P-1', sku: 'S-1', productMedia: ['https://cdn/1.jpg'] }),
    listing({ storeKey: 'A', parentSku: 'P-1', sku: 'S-2', productMedia: ['https://cdn/2.jpg'] }),
    listing({ storeKey: 'C', parentSku: 'P-2', sku: 'S-3', productMedia: [] }),
  ]);
  assert.equal(counts.rows, 4);
  assert.equal(counts.parentSkus, 2);
  assert.equal(counts.skus, 3);
  assert.equal(counts.storeProducts, 3, 'A|P-1, B|P-1, C|P-2');
  assert.equal(counts.storeVariants, 4);
  assert.equal(counts.stores, 3);
  assert.equal(counts.uniqueImageUrls, 2);
  assert.equal(counts.imageReferences, 3);
});
