import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { FINDING_CODES } from '../../findings.ts';
import { type FixtureCell, buildXlsx } from '../../testing/xlsx-fixture.ts';
import { OPEN_ENDED_DATE_SENTINEL } from '../../values.ts';
import { detectDianxiaomiWorkbook, readDianxiaomiRows } from './workbook.ts';

const HEADERS = [
  '父SKU',
  'SKU',
  '商品标题',
  '店铺',
  '品牌',
  '商品描述',
  '价格',
  '促销价',
  '促销开始时间',
  '促销结束时间',
  '库存',
  '属性',
  'Lazada产品ID',
  '类目ID',
  '图片1',
  '图片2',
  '属性名1',
  '属性值1',
  '创建时间',
];

/** Column indices, so a test can set one field without counting commas. */
const COL = Object.fromEntries(HEADERS.map((name, index) => [name, index])) as Record<
  string,
  number
>;

function row(overrides: Record<string, FixtureCell>): FixtureCell[] {
  const cells: FixtureCell[] = new Array(HEADERS.length).fill(null);
  cells[COL.父SKU as number] = 'P-1';
  cells[COL.SKU as number] = 'S-1';
  cells[COL.商品标题 as number] = 'Bluetooth earbuds';
  cells[COL.店铺 as number] = 'ShopA_MY';
  for (const [header, value] of Object.entries(overrides)) {
    cells[COL[header] as number] = value;
  }
  return cells;
}

function workbook(dataRows: readonly FixtureCell[][], headers: readonly FixtureCell[] = HEADERS) {
  return buildXlsx({ sheets: [{ name: '全球产品', rows: [headers, ...dataRows] }] });
}

function read(dataRows: readonly FixtureCell[][], headers?: readonly FixtureCell[]) {
  const result = readDianxiaomiRows(workbook(dataRows, headers));
  assert.equal(result.ok, true, `expected a readable workbook, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

const codes = (findings: readonly { code: string }[]) => findings.map((finding) => finding.code);

// --- detection and structural rejection ------------------------------------

test('detects a workbook by content', () => {
  assert.equal(detectDianxiaomiWorkbook(workbook([row({})])), true);
  assert.equal(detectDianxiaomiWorkbook(Buffer.from('nonsense', 'utf8')), false);
});

test('rejects the whole workbook when a required identity column is missing', () => {
  const result = readDianxiaomiRows(workbook([['P-1', 'title']], ['父SKU', '商品标题']));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.deepEqual(codes(result.findings), [FINDING_CODES.WORKBOOK_MISSING_REQUIRED_HEADERS]);
  // The message must name what is missing AND what was there, or calibrating
  // the alias table means guessing twice.
  assert.match(result.findings[0]?.message ?? '', /sku/);
  assert.match(result.findings[0]?.message ?? '', /store/);
  assert.match(result.findings[0]?.message ?? '', /父SKU/);
});

test('rejects a workbook with no data rows', () => {
  const result = readDianxiaomiRows(workbook([]));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.ok(codes(result.findings).includes(FINDING_CODES.WORKBOOK_NO_DATA_ROWS));
});

test('rejects a workbook whose bytes are not a spreadsheet', () => {
  const result = readDianxiaomiRows(Buffer.from('not a workbook at all', 'utf8'));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.deepEqual(codes(result.findings), [FINDING_CODES.WORKBOOK_UNREADABLE]);
});

test('rejects a workbook where two columns claim the same field', () => {
  const result = readDianxiaomiRows(workbook([row({})], [...HEADERS, 'price']));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.deepEqual(codes(result.findings), [FINDING_CODES.WORKBOOK_DUPLICATE_HEADER]);
});

test('finds the header row under a title banner', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [['全球产品导出'], [], HEADERS, row({})] }],
  });
  const result = readDianxiaomiRows(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.headerRowNumber, 3);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.rowNumber, 4);
});

// --- reordering and unknown columns ----------------------------------------

test('parses correctly when the columns are reordered', () => {
  const reordered = ['店铺', '商品标题', 'SKU', '父SKU', '库存'];
  const result = readDianxiaomiRows(
    buildXlsx({ sheets: [{ name: 'S', rows: [reordered, ['ShopA', 'Title', 'S-9', 'P-9', 7]] }] }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  const parsed = result.rows[0];
  assert.equal(parsed?.parentSku, 'P-9');
  assert.equal(parsed?.sku, 'S-9');
  assert.equal(parsed?.store, 'ShopA');
  assert.equal(parsed?.stock, 7);
});

test('reports unknown columns and keeps importing', () => {
  const result = read([row({})], [...HEADERS, '运营备注']);
  assert.deepEqual(result.ignoredHeaders, ['运营备注']);
  assert.ok(codes(result.findings).includes(FINDING_CODES.HEADER_UNKNOWN));
  assert.equal(result.rows.length, 1);
});

test('imports when every optional column is absent', () => {
  const result = readDianxiaomiRows(
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            ['父SKU', 'SKU', '商品标题', '店铺'],
            ['P-1', 'S-1', 'T', 'A'],
          ],
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.sourceRegularPrice, undefined);
  assert.equal(result.rows[0]?.stock, undefined);
  assert.deepEqual(result.rows[0]?.imageUrls, []);
});

// --- identity ---------------------------------------------------------------

test('trims identifiers but keeps the original text', () => {
  const result = read([row({ 父SKU: '  P-1  ', SKU: { inline: '  S-1  ' } })]);
  assert.equal(result.rows[0]?.parentSku, 'P-1');
  assert.equal(result.rows[0]?.sku, 'S-1');
});

test('keeps numeric-looking SKUs as strings', () => {
  const result = read([row({ SKU: { inline: '0012300' }, 父SKU: { inline: '1e5' } })]);
  assert.equal(result.rows[0]?.sku, '0012300');
  assert.equal(result.rows[0]?.parentSku, '1e5');
});

test('rejects only the rows that cannot be identified', () => {
  const result = read([
    row({}),
    row({ SKU: null }),
    row({ 父SKU: 'P-2', SKU: 'S-2' }),
    row({ 店铺: null }),
  ]);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((parsed) => parsed.sku),
    ['S-1', 'S-2'],
  );
  const errors = result.findings.filter((finding) => finding.severity === 'error');
  assert.deepEqual(codes(errors), [FINDING_CODES.ROW_MISSING_SKU, FINDING_CODES.ROW_MISSING_STORE]);
  // Every finding must point at a row, or the operator cannot act on it.
  for (const finding of errors) assert.equal(typeof finding.rowNumber, 'number');
});

test('skips trailing blank padding rows without reporting them', () => {
  const result = read([row({}), [], [null, null, null, null]]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.dataRowCount, 1);
  assert.deepEqual(
    result.findings.filter((finding) => finding.severity === 'error'),
    [],
  );
});

// --- prices -----------------------------------------------------------------

test('reads source prices as CNY minor units regardless of the store suffix', () => {
  const result = read([row({ 店铺: 'ShopA_MY', 价格: { inline: '1299.00' } })]);
  assert.deepEqual(result.rows[0]?.sourceRegularPrice, { amountMinor: 129900, currency: 'CNY' });
});

test('reports an unusable price and leaves it unset rather than zeroing it', () => {
  const result = read([row({ 价格: { inline: 'N/A' }, 促销价: { inline: '-5' } })]);
  assert.equal(result.rows[0]?.sourceRegularPrice, undefined);
  assert.equal(result.rows[0]?.sourcePromotionPrice, undefined);
  assert.equal(
    codes(result.findings).filter((code) => code === FINDING_CODES.PRICE_INVALID).length,
    2,
  );
  assert.equal(result.rows.length, 1, 'a bad price must not drop the row');
});

// --- stock ------------------------------------------------------------------

test('reads whole-number stock', () => {
  assert.equal(read([row({ 库存: 42 })]).rows[0]?.stock, 42);
});

test('reports unusable stock and leaves inventory unknown', () => {
  const result = read([row({ 库存: { inline: 'many' } })]);
  assert.equal(result.rows[0]?.stock, undefined);
  assert.ok(codes(result.findings).includes(FINDING_CODES.STOCK_INVALID));
});

// --- dates ------------------------------------------------------------------

test('reads a date-formatted cell as UTC+8 and keeps the source text', () => {
  const result = read([row({ 创建时间: { dateSerial: 46260 } })]);
  assert.equal(result.rows[0]?.sourceCreatedAt?.source, '2026-08-26 00:00:00');
  assert.equal(result.rows[0]?.sourceCreatedAt?.iso, '2026-08-25T16:00:00.000Z');
});

test('flags the open-ended promotion sentinel', () => {
  const result = read([row({ 促销结束时间: { inline: OPEN_ENDED_DATE_SENTINEL } })]);
  assert.equal(result.rows[0]?.promotionEnd?.openEnded, true);
  assert.equal(result.rows[0]?.promotionEnd?.source, OPEN_ENDED_DATE_SENTINEL);
  assert.ok(codes(result.findings).includes(FINDING_CODES.PROMOTION_DATE_OPEN_ENDED));
});

test('reports an unusable date without dropping the row', () => {
  const result = read([row({ 促销开始时间: { inline: '31/02/2026' } })]);
  assert.equal(result.rows[0]?.promotionStart, undefined);
  assert.ok(codes(result.findings).includes(FINDING_CODES.DATE_INVALID));
  assert.equal(result.rows.length, 1);
});

// --- descriptions -----------------------------------------------------------

test('treats placeholder descriptions as absent and says so', () => {
  const result = read([row({ 商品描述: { inline: '<p>1</p>' } })]);
  assert.equal(result.rows[0]?.description.placeholder, true);
  assert.equal(result.rows[0]?.description.text, undefined);
  assert.ok(codes(result.findings).includes(FINDING_CODES.DESCRIPTION_PLACEHOLDER));
});

test('never carries unsafe description markup through', () => {
  const result = read([row({ 商品描述: { inline: '<p>Good</p><script>steal()</script>' } })]);
  const description = result.rows[0]?.description;
  assert.equal(description?.placeholder, false);
  assert.equal(description?.html, '<p>Good</p>');
  assert.equal(description?.text, 'Good');
  assert.ok(codes(result.findings).includes(FINDING_CODES.DESCRIPTION_HTML_SANITIZED));
});

// --- attributes -------------------------------------------------------------

test('parses attribute JSON into scalars', () => {
  const result = read([row({ 属性: { inline: '{"color":"black","count":2,"boxed":true}' } })]);
  assert.deepEqual(result.rows[0]?.attributes, { color: 'black', count: 2, boxed: true });
});

test('malformed attribute JSON affects only its own row', () => {
  const result = read([
    row({ 属性: { inline: '{"color":' } }),
    row({ SKU: 'S-2', 属性: { inline: '{"color":"red"}' } }),
  ]);
  assert.deepEqual(result.rows[0]?.attributes, {});
  assert.deepEqual(result.rows[1]?.attributes, { color: 'red' });
  assert.equal(result.rows.length, 2);
  assert.ok(codes(result.findings).includes(FINDING_CODES.ATTRIBUTES_JSON_INVALID));
});

test('an attribute named __proto__ cannot reach Object.prototype', () => {
  const result = read([row({ 属性: { inline: '{"__proto__":{"polluted":true},"ok":"yes"}' } })]);
  assert.deepEqual(result.rows[0]?.attributes, { ok: 'yes' });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

// --- options and images -----------------------------------------------------

test('reads named option values', () => {
  const result = read([row({ 属性名1: 'Color', 属性值1: 'Black' })]);
  assert.deepEqual(result.rows[0]?.optionValues, { Color: 'Black' });
});

test('gives an unnamed option a stable key', () => {
  const result = read([row({ 属性值1: 'Black' })]);
  assert.deepEqual(result.rows[0]?.optionValues, { option1: 'Black' });
});

test('collects image URLs across columns, deduplicated and in order', () => {
  const result = read([
    row({
      图片1: { inline: 'https://cdn.example/b.jpg,https://cdn.example/a.jpg' },
      图片2: { inline: 'https://cdn.example/b.jpg' },
    }),
  ]);
  assert.deepEqual(result.rows[0]?.imageUrls, [
    'https://cdn.example/b.jpg',
    'https://cdn.example/a.jpg',
  ]);
});

test('reports an unusable image address and keeps the usable ones', () => {
  const result = read([
    row({ 图片1: { inline: 'javascript:alert(1) https://cdn.example/a.jpg' } }),
  ]);
  assert.deepEqual(result.rows[0]?.imageUrls, ['https://cdn.example/a.jpg']);
  assert.ok(codes(result.findings).includes(FINDING_CODES.IMAGE_URL_INVALID));
});

// --- source listing status --------------------------------------------------

test('treats a row without a marketplace product id as a source draft', () => {
  const result = read([row({}), row({ SKU: 'S-2', Lazada产品ID: { inline: '99887766' } })]);
  assert.equal(result.rows[0]?.sourceListingStatus, 'draft');
  assert.equal(result.rows[0]?.platformProductId, undefined);
  assert.equal(result.rows[1]?.sourceListingStatus, 'published');
  assert.equal(result.rows[1]?.platformProductId, '99887766');
});

// --- template fingerprint ---------------------------------------------------

test('gives the same template id to two exports of the same template', () => {
  assert.equal(read([row({})]).templateId, read([row({}), row({ SKU: 'S-2' })]).templateId);
});

test('gives a different template id when the recognised columns change', () => {
  const withPrice = read([row({})]).templateId;
  const withoutPrice = readDianxiaomiRows(
    buildXlsx({
      sheets: [
        {
          name: 'S',
          rows: [
            ['父SKU', 'SKU', '商品标题', '店铺'],
            ['P', 'S', 'T', 'A'],
          ],
        },
      ],
    }),
  );
  assert.equal(withoutPrice.ok, true);
  if (!withoutPrice.ok) throw new Error('unreachable');
  assert.notEqual(withPrice, withoutPrice.templateId);
});
