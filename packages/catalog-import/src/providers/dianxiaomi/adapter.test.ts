import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { FINDING_CODES } from '../../findings.ts';
import { displayQuantity } from '../../inventory.ts';
import {
  ACCEPTANCE_COUNTS,
  buildAcceptanceWorkbook,
  planAcceptanceRows,
} from '../../testing/dianxiaomi-acceptance-fixture.ts';
import { dianxiaomiAdapter, parseDianxiaomiWorkbook, sha256Hex } from './adapter.ts';

const workbook = buildAcceptanceWorkbook();
const parsed = parseDianxiaomiWorkbook(workbook);

// --- the plan reproduces the documented workbook shape ----------------------

test('the acceptance plan matches the verified workbook cardinalities', () => {
  const planned = planAcceptanceRows();
  assert.equal(planned.length, ACCEPTANCE_COUNTS.rows);
  assert.equal(new Set(planned.map((row) => row.parentSku)).size, ACCEPTANCE_COUNTS.parentSkus);
  assert.equal(new Set(planned.map((row) => row.sku)).size, ACCEPTANCE_COUNTS.skus);
  assert.equal(new Set(planned.map((row) => row.store)).size, ACCEPTANCE_COUNTS.stores);
  assert.equal(
    new Set(planned.map((row) => `${row.store}|${row.parentSku}`)).size,
    ACCEPTANCE_COUNTS.storeProducts,
  );
  assert.equal(
    new Set(planned.map((row) => `${row.store}|${row.sku}`)).size,
    ACCEPTANCE_COUNTS.storeVariants,
  );
  assert.equal(
    planned.filter((row) => row.isRepeat).length,
    ACCEPTANCE_COUNTS.skusRepeatedAcrossStores,
  );
});

test('every SKU listed in two shops reports the SAME stock in both', () => {
  // This is the fact that makes summing wrong and the common value right.
  const byStock = new Map<string, Set<number>>();
  for (const row of planAcceptanceRows()) {
    byStock.set(row.sku, (byStock.get(row.sku) ?? new Set()).add(row.quantity));
  }
  for (const [sku, quantities] of byStock) {
    assert.equal(quantities.size, 1, `SKU ${sku} disagrees with itself across shops`);
  }
});

// --- parsing the acceptance workbook ---------------------------------------

test('the parsed workbook reproduces every documented count', () => {
  assert.equal(parsed.structurallyValid, true);
  assert.equal(parsed.counts.rows, ACCEPTANCE_COUNTS.rows);
  assert.equal(parsed.counts.parentSkus, ACCEPTANCE_COUNTS.parentSkus);
  assert.equal(parsed.counts.skus, ACCEPTANCE_COUNTS.skus);
  assert.equal(parsed.counts.storeProducts, ACCEPTANCE_COUNTS.storeProducts);
  assert.equal(parsed.counts.storeVariants, ACCEPTANCE_COUNTS.storeVariants);
  assert.equal(parsed.counts.stores, ACCEPTANCE_COUNTS.stores);
  assert.equal(parsed.counts.uniqueImageUrls, ACCEPTANCE_COUNTS.uniqueImageUrls);
  assert.equal(parsed.counts.imageReferences, ACCEPTANCE_COUNTS.imageReferences);
});

test('312 source rows collapse to 77 products and 289 variants', () => {
  assert.equal(parsed.bundle.products.length, ACCEPTANCE_COUNTS.parentSkus);
  const variants = parsed.bundle.products.flatMap((product) => product.variants);
  assert.equal(variants.length, ACCEPTANCE_COUNTS.skus);
  assert.equal(parsed.storeListings.length, ACCEPTANCE_COUNTS.storeVariants);
  assert.deepEqual(parsed.quarantined, []);
});

test('marketplace ids appear on exactly the documented number of rows', () => {
  const withId = parsed.storeListings.filter((entry) => entry.externalProductId !== undefined);
  assert.equal(withId.length, ACCEPTANCE_COUNTS.rowsWithMarketplaceId);
  assert.equal(
    new Set(withId.map((entry) => entry.externalProductId)).size,
    ACCEPTANCE_COUNTS.marketplaceIds,
  );
});

test('a SKU sold in two shops yields one variant and one stock figure', () => {
  const repeated = planAcceptanceRows().filter((row) => row.isRepeat);
  const sample = repeated[0];
  assert.ok(sample);
  const listings = parsed.storeListings.filter((entry) => entry.sku === sample.sku);
  assert.equal(listings.length, 2, 'both shop lines are preserved');
  assert.equal(new Set(listings.map((entry) => entry.storeKey)).size, 2);

  const variants = parsed.bundle.products.flatMap((product) => product.variants);
  const matching = variants.filter((variant) => variant.sku === sample.sku);
  assert.equal(matching.length, 1, 'the website gets one variant, not two');

  const resolved = parsed.inventory.find(
    (entry) => entry.candidateSkuKey === `dianxiaomi:${sample.sku.toLowerCase()}`,
  );
  assert.equal(resolved?.resolution.state, 'known');
  assert.equal(
    displayQuantity(resolved?.resolution as never),
    sample.quantity,
    'the shared value once, not the sum',
  );
});

test('source-draft families are still importable candidates', () => {
  const drafts = parsed.bundle.products.filter(
    (product) => product.sourceListingStatus === 'draft',
  );
  assert.ok(drafts.length > 0);
  assert.ok((drafts[0]?.variants.length ?? 0) > 0);
});

test('prices are CNY minor units and no legacy USD field is produced', () => {
  const variant = parsed.bundle.products[0]?.variants[0];
  assert.equal(variant?.sourceRegularPrice?.currency, 'CNY');
  assert.ok((variant?.sourceRegularPrice?.amountMinor ?? 0) > 0);
  assert.equal('unitPrice' in (variant ?? {}), false);
});

test('placeholder descriptions are reported and not carried as content', () => {
  const placeholders = parsed.bundle.findings.filter(
    (finding) => finding.code === FINDING_CODES.DESCRIPTION_PLACEHOLDER,
  );
  assert.ok(placeholders.length > 0);
  const bare = parsed.bundle.products.find((product) => product.descriptionText === undefined);
  assert.ok(bare, 'at least one family has no usable description');
});

test('the open-ended promotion sentinel is flagged, not shown as a date', () => {
  assert.ok(
    parsed.bundle.findings.some(
      (finding) => finding.code === FINDING_CODES.PROMOTION_DATE_OPEN_ENDED,
    ),
  );
});

test('no unknown columns and no structural findings on a clean template', () => {
  assert.deepEqual(parsed.bundle.ignoredHeaders, []);
  const structural = parsed.bundle.findings.filter((finding) =>
    finding.code.startsWith('WORKBOOK_'),
  );
  assert.deepEqual(structural, []);
});

test('findings are ordered by row so an operator can work down the list', () => {
  const rowNumbers = parsed.bundle.findings.map((finding) => finding.rowNumber ?? 0);
  assert.deepEqual(
    rowNumbers,
    [...rowNumbers].sort((a, b) => a - b),
  );
});

// --- determinism and the adapter contract -----------------------------------

test('building the same fixture twice produces identical bytes', () => {
  assert.ok(buildAcceptanceWorkbook().equals(buildAcceptanceWorkbook()));
  assert.equal(sha256Hex(buildAcceptanceWorkbook()), sha256Hex(workbook));
});

test('parsing is deterministic, so a repeat import can be compared', () => {
  const again = parseDianxiaomiWorkbook(buildAcceptanceWorkbook());
  assert.equal(again.bundle.sourceFileSha256, parsed.bundle.sourceFileSha256);
  assert.deepEqual(again.bundle.products, parsed.bundle.products);
  assert.deepEqual(again.bundle.findings, parsed.bundle.findings);
});

test('a changed revision differs from the base', () => {
  const changed = parseDianxiaomiWorkbook(buildAcceptanceWorkbook({ revision: 'changed' }));
  assert.notEqual(changed.bundle.sourceFileSha256, parsed.bundle.sourceFileSha256);
  assert.equal(changed.counts.rows, ACCEPTANCE_COUNTS.rows - 1);
});

test('the adapter satisfies the provider-neutral contract', async () => {
  assert.equal(dianxiaomiAdapter.provider, 'dianxiaomi');
  assert.equal(await dianxiaomiAdapter.detect(workbook), true);
  assert.equal(await dianxiaomiAdapter.detect(Buffer.from('nope', 'utf8')), false);
  const bundle = await dianxiaomiAdapter.parse(workbook);
  assert.equal(bundle.schemaVersion, '1');
  assert.equal(bundle.provider, 'dianxiaomi');
  assert.equal(bundle.products.length, ACCEPTANCE_COUNTS.parentSkus);
});

test('an unreadable file yields a structural finding, not a thrown error', () => {
  const broken = parseDianxiaomiWorkbook(Buffer.from('not a workbook', 'utf8'));
  assert.equal(broken.structurallyValid, false);
  assert.deepEqual(broken.bundle.products, []);
  assert.equal(broken.bundle.findings[0]?.code, FINDING_CODES.WORKBOOK_UNREADABLE);
  // The hash is still computed, so a re-upload of the same bad file is
  // recognisable rather than reprocessed from scratch.
  assert.equal(broken.bundle.sourceFileSha256.length, 64);
});
