/**
 * Regression tests pinning the alias table to the REAL export template.
 *
 * Calibrated against `dianxiaomi_lazada_export_original.xlsx` (SHA-256
 * 57b29269…6582) on 2026-08-26. Headers are template structure and are
 * reproduced verbatim; every value here is synthetic, so no customer data
 * enters the repository.
 *
 * Each test corresponds to something the real file does that the table
 * originally got wrong — these are the assertions that would have caught the
 * miscalibration before the file arrived.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FINDING_CODES } from '../../findings.ts';
import {
  REAL_TEMPLATE_HEADERS,
  buildRealTemplateWorkbook,
  realTemplateRow,
} from '../../testing/dianxiaomi-real-template-fixture.ts';
import { parseDianxiaomiWorkbook } from './adapter.ts';
import { mapHeaders } from './headers.ts';
import { readDianxiaomiRows } from './workbook.ts';

function readRows(rows: readonly ReturnType<typeof realTemplateRow>[]) {
  const result = readDianxiaomiRows(buildRealTemplateWorkbook(rows));
  assert.equal(result.ok, true, `expected a readable workbook: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);

// --- header calibration -----------------------------------------------------

test('every column of the real template is recognised', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  assert.deepEqual(mapping.missingRequired, []);
  assert.deepEqual(
    mapping.unknown.map((entry) => entry.label),
    [],
    'no column of the shipped template may read as unknown',
  );
  assert.deepEqual(mapping.duplicates, []);
  assert.equal(REAL_TEMPLATE_HEADERS.length, 44, 'the template has 44 columns');
});

test('the columns we knowingly skip are reported separately from unknown ones', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  assert.deepEqual(
    mapping.recognisedUnused.map((entry) => entry.label).sort(),
    [
      '备注',
      '包装内容',
      '来源URL',
      '税',
      '营销图-场景图',
      '营销图-白底图',
      '视频URL',
      '质保类型',
    ].sort(),
  );
});

test('the four required identity columns are the ones the design names', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  assert.equal(mapping.columns.get('parentSku'), 0);
  assert.equal(mapping.columns.get('title'), 2);
  assert.equal(mapping.columns.get('sku'), 5);
  assert.equal(mapping.columns.get('store'), 39);
});

// --- the specific miscalibrations the real file exposed ---------------------

test('the gallery is the main column plus 附图1…附图7', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  // Columns 19..26 zero-based: 产品图片主图(URL) and 附图1..附图7.
  assert.deepEqual(mapping.multiColumns.get('imageUrls'), [19, 20, 21, 22, 23, 24, 25, 26]);
});

test('the variant image is its own field, not part of the product gallery', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  assert.equal(mapping.columns.get('variantImageUrl'), 27);
  assert.equal((mapping.multiColumns.get('imageUrls') ?? []).includes(27), false);
});

test('the supplier page URL is never treated as an image', () => {
  // 来源URL holds a supplier listing address. Counting it as an image would
  // both inflate the gallery and put a supplier link on the storefront.
  const result = readRows([realTemplateRow({ galleryImages: 2 })]);
  const urls = result.rows[0]?.imageUrls ?? [];
  assert.equal(urls.length, 2);
  for (const url of urls) assert.equal(url.includes('supplier.example.test'), false);
});

test('option slots numbered with Chinese numerals are read', () => {
  const result = readRows([realTemplateRow()]);
  assert.deepEqual(result.rows[0]?.optionValues, { Colour: 'Black' });
});

test('关键属性 is the attributes column', () => {
  const result = readRows([realTemplateRow()]);
  assert.deepEqual(result.rows[0]?.attributes, { Material: 'ABS', Origin: 'Synthetic' });
});

test('物理 spec columns carrying a unit qualifier still map', () => {
  const mapping = mapHeaders([...REAL_TEMPLATE_HEADERS]);
  assert.equal(mapping.columns.get('weightKg'), 32);
  assert.equal(mapping.columns.get('lengthCm'), 33);
  assert.equal(mapping.columns.get('widthCm'), 34);
  assert.equal(mapping.columns.get('heightCm'), 35);
});

// --- source listing status (design §9) --------------------------------------

test('a marketplace id together with a listing timestamp means source-published', () => {
  const result = readRows([realTemplateRow({ listedAs: '9900001' })]);
  assert.equal(result.rows[0]?.sourceListingStatus, 'published');
  assert.equal(result.rows[0]?.platformProductId, '9900001');
  assert.equal(result.rows[0]?.platformListedAt?.source, '2026-08-02 10:00:00');
});

test('a row with neither is a source draft and still importable', () => {
  const result = readRows([realTemplateRow({ listedAs: null })]);
  assert.equal(result.rows[0]?.sourceListingStatus, 'draft');
  assert.equal(result.rows[0]?.platformProductId, undefined);
});

// --- descriptions (design §11) ----------------------------------------------

test('the template placeholder pair falls through to structured copy', () => {
  const result = readRows([realTemplateRow({ description: '1', shortDescription: '<p>1</p>' })]);
  const description = result.rows[0]?.description;
  assert.equal(description?.source, 'structured');
  assert.ok(description?.text.includes('Synthetic product title'));
  assert.ok(description?.text.includes('Brand: SyntheticBrand'));
  assert.ok(description?.text.includes('Material: ABS'));
  assert.ok(codes(result.findings).includes(FINDING_CODES.DESCRIPTION_FALLBACK_STRUCTURED));
});

test('a usable short description is preferred over generated copy', () => {
  const result = readRows([
    realTemplateRow({ description: '1', shortDescription: '<p>A real short description.</p>' }),
  ]);
  assert.equal(result.rows[0]?.description.source, 'shortDescription');
  assert.equal(result.rows[0]?.description.text, 'A real short description.');
});

// --- promotions -------------------------------------------------------------

test('the far-future promotion end is flagged as the open-ended sentinel', () => {
  const result = readRows([realTemplateRow()]);
  assert.equal(result.rows[0]?.promotionEnd?.openEnded, true);
  assert.ok(codes(result.findings).includes(FINDING_CODES.PROMOTION_DATE_OPEN_ENDED));
});

// --- gallery ceiling (design §12.2) -----------------------------------------

test('a row cannot exceed the catalog gallery ceiling', () => {
  const result = readRows([realTemplateRow({ galleryImages: 8 })]);
  const urls = result.rows[0]?.imageUrls ?? [];
  assert.ok(urls.length <= 9, 'gallery is capped at the catalog maximum');
});

// --- end-to-end shape -------------------------------------------------------

test('a multi-store, multi-variant template parses into the expected shape', () => {
  const detail = parseDianxiaomiWorkbook(
    buildRealTemplateWorkbook([
      realTemplateRow({ parentSku: 'PS-1', sku: 'SK-1', store: 'ShopA_MY', stock: 40 }),
      realTemplateRow({ parentSku: 'PS-1', sku: 'SK-2', store: 'ShopA_MY', stock: 7 }),
      // Same SKU in a second shop, same stock: one variant, one count.
      realTemplateRow({ parentSku: 'PS-1', sku: 'SK-1', store: 'ShopB_MY', stock: 40 }),
    ]),
  );
  assert.equal(detail.structurallyValid, true);
  assert.deepEqual(detail.bundle.ignoredHeaders, []);
  assert.equal(detail.counts.rows, 3);
  assert.equal(detail.counts.skus, 2);
  assert.equal(detail.counts.storeVariants, 3);
  assert.equal(detail.counts.skusInMultipleStores, 1);
  assert.equal(detail.bundle.products.length, 1);
  assert.equal(detail.bundle.products[0]?.variants.length, 2);

  const shared = detail.inventory.find((entry) => entry.candidateSkuKey === 'dianxiaomi:sk-1');
  assert.equal(shared?.resolution.state, 'known');
  if (shared?.resolution.state === 'known') assert.equal(shared.resolution.quantity, 40);
});
