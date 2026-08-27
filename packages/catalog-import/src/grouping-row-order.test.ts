/**
 * Row-order invariance for product-level field selection.
 *
 * A product family spans several variant rows, and each row carries its own
 * description, title and brand. Which one becomes the product's is a choice,
 * and the wrong choice is invisible: it produces a plausible product page
 * built from the wrong row.
 *
 * Two properties are asserted here.
 *
 * PERMUTATION INVARIANCE. Re-ordering a family's rows must not change the
 * product. A merchant re-exporting the same catalog with rows in a different
 * order would otherwise get a different description on their website, with no
 * source change to explain it, and a repeat-import delta that cannot be
 * reconciled against anything.
 *
 * AUTHORED COPY OUTRANKS GENERATED COPY. Once the fallback chain fills every
 * row's description, "first non-empty wins" silently prefers whichever row came
 * first — so a generated line could beat a sibling row's real merchant
 * description purely on position. Provenance has to decide before position
 * does.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { type SourceListing, groupListings } from './grouping.ts';

let seq = 0;

function listing(overrides: Partial<SourceListing> = {}): SourceListing {
  seq += 1;
  return {
    rowNumber: seq,
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    storeKey: 'ShopA',
    parentSku: 'P-1',
    sku: `S-${seq}`,
    title: 'Family title',
    attributes: {},
    optionValues: {},
    productMedia: [],
    sourceListingStatus: 'published',
    ...overrides,
  };
}

/** Every ordering of a 3-element array. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

const productOf = (rows: readonly SourceListing[]) => {
  const result = groupListings(rows);
  assert.equal(result.products.length, 1, 'the fixture is one family');
  return result.products[0];
};

// --- the defect this file exists to prevent ---------------------------------

test('a sibling row with authored copy beats a row with generated copy', () => {
  // Row 1 has only generated copy; row 2 carries what the merchant wrote.
  // Position must not decide this.
  const generated = listing({
    sku: 'S-A',
    descriptionText: 'Family title\n\nBrand: Acme',
    descriptionSource: 'structured',
  });
  const authored = listing({
    sku: 'S-B',
    descriptionText: 'The merchant wrote this.',
    descriptionHtml: '<p>The merchant wrote this.</p>',
    descriptionSource: 'description',
  });

  for (const order of permutations([generated, authored])) {
    const product = productOf(order);
    assert.equal(product?.descriptionText, 'The merchant wrote this.');
    assert.equal(product?.descriptionSource, 'description');
    assert.equal(product?.descriptionHtml, '<p>The merchant wrote this.</p>');
  }
});

test('the fallback ranking holds across every rung', () => {
  const rungs: [NonNullable<SourceListing['descriptionSource']>, string][] = [
    ['titleAndSpecs', 'title only'],
    ['structured', 'structured copy'],
    ['shortDescription', 'the short one'],
    ['description', 'the real one'],
  ];
  const rows = rungs.map(([descriptionSource, descriptionText], index) =>
    listing({ sku: `S-${index}`, descriptionText, descriptionSource }),
  );
  // Reversed, rotated and original orders must all agree.
  for (const order of [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]) {
    const product = productOf(order);
    assert.equal(product?.descriptionText, 'the real one');
    assert.equal(product?.descriptionSource, 'description');
  }
});

// --- permutation invariance -------------------------------------------------

test('description selection is identical under every ordering of the rows', () => {
  const rows = [
    listing({ sku: 'S-1', descriptionText: 'Shared copy', descriptionSource: 'description' }),
    listing({ sku: 'S-2', descriptionText: 'Shared copy', descriptionSource: 'description' }),
    listing({ sku: 'S-3', descriptionText: 'A different line', descriptionSource: 'description' }),
  ];
  const outcomes = new Set(
    permutations(rows).map((order) => JSON.stringify(productOf(order)?.descriptionText)),
  );
  assert.equal(outcomes.size, 1, `orderings disagreed: ${[...outcomes].join(' | ')}`);
  // Two rows agree on "Shared copy" and one dissents, so the agreed value wins.
  assert.equal(productOf(rows)?.descriptionText, 'Shared copy');
});

test('title, brand and marketplace id are also order-invariant', () => {
  const rows = [
    listing({ sku: 'S-1', title: 'Common title', brand: 'Acme', externalProductId: '111' }),
    listing({ sku: 'S-2', title: 'Common title', brand: 'Acme' }),
    listing({ sku: 'S-3', title: 'Odd one out', brand: 'Globex-longer' }),
  ];
  const seen = new Set(
    permutations(rows).map((order) => {
      const product = productOf(order);
      return JSON.stringify([product?.title, product?.brand, product?.identity.externalProductId]);
    }),
  );
  assert.equal(seen.size, 1, `orderings disagreed: ${[...seen].join(' | ')}`);
  assert.equal(productOf(rows)?.title, 'Common title');
});

test('a two-way tie resolves the same way whichever row comes first', () => {
  // No majority: one row each. The rule must still be a function of the
  // VALUES, not of their position.
  const rows = [
    listing({ sku: 'S-1', descriptionText: 'bbb', descriptionSource: 'description' }),
    listing({ sku: 'S-2', descriptionText: 'aaaa', descriptionSource: 'description' }),
  ];
  const outcomes = new Set(
    permutations(rows).map((order) => String(productOf(order)?.descriptionText)),
  );
  assert.equal(outcomes.size, 1);
  // Longer wins before lexicographic order does, so the fuller copy survives.
  assert.equal(productOf(rows)?.descriptionText, 'aaaa');
});

test('an exact tie on length falls back to a stable lexicographic choice', () => {
  const rows = [
    listing({ sku: 'S-1', descriptionText: 'bbbb', descriptionSource: 'description' }),
    listing({ sku: 'S-2', descriptionText: 'aaaa', descriptionSource: 'description' }),
  ];
  const outcomes = new Set(
    permutations(rows).map((order) => String(productOf(order)?.descriptionText)),
  );
  assert.equal(outcomes.size, 1);
  assert.equal(productOf(rows)?.descriptionText, 'aaaa');
});

// --- the HTML must travel with the text it belongs to -----------------------

test('the selected description keeps its own html and provenance', () => {
  const rows = [
    listing({
      sku: 'S-1',
      descriptionText: 'generated',
      descriptionHtml: '<p>generated</p>',
      descriptionSource: 'structured',
    }),
    listing({
      sku: 'S-2',
      descriptionText: 'authored',
      descriptionHtml: '<p>authored</p>',
      descriptionSource: 'description',
    }),
  ];
  for (const order of permutations(rows)) {
    const product = productOf(order);
    assert.equal(product?.descriptionText, 'authored');
    assert.equal(
      product?.descriptionHtml,
      '<p>authored</p>',
      'html must not come from another row',
    );
    assert.equal(product?.descriptionSource, 'description');
  }
});

test('a family whose rows carry no description at all stays without one', () => {
  const rows = [listing({ sku: 'S-1' }), listing({ sku: 'S-2' })];
  const product = productOf(rows);
  assert.equal(product?.descriptionText, undefined);
  assert.equal(product?.descriptionHtml, undefined);
});

// --- store order must not matter either -------------------------------------

test('the same family listed by several shops resolves identically', () => {
  const rows = [
    listing({
      sku: 'S-1',
      storeKey: 'ShopA',
      descriptionText: 'x',
      descriptionSource: 'structured',
    }),
    listing({
      sku: 'S-1',
      storeKey: 'ShopB',
      descriptionText: 'real',
      descriptionSource: 'description',
    }),
    listing({
      sku: 'S-2',
      storeKey: 'ShopC',
      descriptionText: 'y',
      descriptionSource: 'structured',
    }),
  ];
  const outcomes = new Set(
    permutations(rows).map((order) => String(productOf(order)?.descriptionText)),
  );
  assert.equal(outcomes.size, 1);
  assert.equal(productOf(rows)?.descriptionText, 'real');
});
