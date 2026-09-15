import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type DianxiaomiField,
  HEADER_ALIASES,
  MULTI_VALUE_FIELDS,
  REQUIRED_FIELDS,
  fieldForHeader,
  mapHeaders,
  normalizeHeader,
  stripHeaderQualifier,
} from './headers.ts';

const REQUIRED_ROW = ['父SKU', 'SKU', '商品标题', '店铺'];

// --- table hygiene ----------------------------------------------------------

test('every alias in the table is already in normalized form', () => {
  // A typo like `Price ` in the table would never match anything, and the
  // symptom would be a missing optional column nobody notices for months.
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      assert.equal(normalizeHeader(alias), alias, `alias ${JSON.stringify(alias)} on ${field}`);
    }
  }
});

test('no alias is claimed by two different fields', () => {
  const owner = new Map<string, string>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const previous = owner.get(alias);
      assert.equal(previous, undefined, `alias ${alias} claimed by ${previous} and ${field}`);
      owner.set(alias, field);
    }
  }
});

test('every required field has at least one alias', () => {
  for (const field of REQUIRED_FIELDS) {
    assert.ok((HEADER_ALIASES[field]?.length ?? 0) > 0, `${field} has no alias`);
  }
});

// --- normalization ----------------------------------------------------------

test('normalizes case, spacing, full-width forms and decoration', () => {
  assert.equal(normalizeHeader('  Parent SKU  '), 'parent sku');
  assert.equal(normalizeHeader('ＳＫＵ'), 'sku');
  assert.equal(normalizeHeader('商品标题：'), '商品标题');
  assert.equal(normalizeHeader('*店铺'), '店铺');
  assert.equal(normalizeHeader('Store *'), 'store');
  assert.equal(normalizeHeader('Parent   SKU'), 'parent sku');
  assert.equal(normalizeHeader(undefined), '');
});

test('strips a trailing unit qualifier as a second chance', () => {
  assert.equal(stripHeaderQualifier('价格(元)'), '价格');
  assert.equal(stripHeaderQualifier('weight (kg)'), 'weight');
  assert.equal(stripHeaderQualifier('库存【总】'), '库存');
  assert.equal(stripHeaderQualifier('价格'), '价格');
});

test('matches a header that carries a unit qualifier', () => {
  assert.equal(fieldForHeader('价格(元)'), 'regularPrice');
  assert.equal(fieldForHeader('Weight (kg)'), 'weightKg');
});

test('matches numbered image columns onto one logical field', () => {
  for (const header of ['图片1', '图片 2', '主图3', 'image_4', 'Image 10', '图片地址1']) {
    assert.equal(fieldForHeader(header), 'imageUrls', header);
  }
});

test('leaves a genuinely unknown header unmatched', () => {
  assert.equal(fieldForHeader('运营备注'), null);
  assert.equal(fieldForHeader('some future column'), null);
  assert.equal(fieldForHeader(''), null);
});

// --- mapping ----------------------------------------------------------------

test('maps a well-formed header row', () => {
  const mapping = mapHeaders([...REQUIRED_ROW, '价格', '库存']);
  assert.deepEqual(mapping.missingRequired, []);
  assert.equal(mapping.columns.get('parentSku'), 0);
  assert.equal(mapping.columns.get('sku'), 1);
  assert.equal(mapping.columns.get('title'), 2);
  assert.equal(mapping.columns.get('store'), 3);
  assert.equal(mapping.columns.get('regularPrice'), 4);
  assert.equal(mapping.columns.get('stock'), 5);
  assert.deepEqual(mapping.unknown, []);
});

test('reordered columns map to the same fields', () => {
  const forward = mapHeaders(['父SKU', 'SKU', '商品标题', '店铺', '价格']);
  const shuffled = mapHeaders(['价格', '店铺', '商品标题', 'SKU', '父SKU']);
  assert.deepEqual(shuffled.missingRequired, []);
  assert.equal(shuffled.columns.get('parentSku'), 4);
  assert.equal(shuffled.columns.get('regularPrice'), 0);
  // Same field set either way — only the positions differ.
  assert.deepEqual([...forward.columns.keys()].sort(), [...shuffled.columns.keys()].sort());
});

test('reports unknown columns without treating them as an error', () => {
  const mapping = mapHeaders([...REQUIRED_ROW, '运营备注', '未来字段']);
  assert.deepEqual(mapping.missingRequired, []);
  assert.deepEqual(
    mapping.unknown.map((entry) => entry.label),
    ['运营备注', '未来字段'],
  );
  assert.deepEqual(
    mapping.unknown.map((entry) => entry.columnIndex),
    [4, 5],
  );
});

test('collects every numbered image column in workbook order', () => {
  const mapping = mapHeaders([...REQUIRED_ROW, '图片3', '图片1', '图片2']);
  assert.deepEqual(mapping.multiColumns.get('imageUrls'), [4, 5, 6]);
  assert.ok(MULTI_VALUE_FIELDS.has('imageUrls'));
});

test('names every missing required field so the operator can see which', () => {
  const mapping = mapHeaders(['SKU', '商品标题']);
  assert.deepEqual(mapping.missingRequired.sort(), ['parentSku', 'store'] as DianxiaomiField[]);
});

test('flags an ambiguous duplicate of a single-valued column', () => {
  // Two columns both claiming to be the price is not something to guess at.
  const mapping = mapHeaders([...REQUIRED_ROW, '价格', 'price']);
  assert.equal(mapping.duplicates.length, 1);
  assert.equal(mapping.duplicates[0]?.field, 'regularPrice');
  assert.deepEqual(mapping.duplicates[0]?.labels, ['price']);
  // The first occurrence still wins, so the rest of the row stays readable.
  assert.equal(mapping.columns.get('regularPrice'), 4);
});

test('ignores blank spacer columns entirely', () => {
  const mapping = mapHeaders(['父SKU', '', 'SKU', undefined, '商品标题', '   ', '店铺']);
  assert.deepEqual(mapping.missingRequired, []);
  assert.deepEqual(mapping.unknown, []);
  assert.equal(mapping.columns.get('sku'), 2);
  assert.equal(mapping.columns.get('store'), 6);
});

test('records the headers actually present, for a rejection message', () => {
  const mapping = mapHeaders(['SKU', '', '运营备注']);
  assert.deepEqual(mapping.presentHeaders, ['SKU', '运营备注']);
});
