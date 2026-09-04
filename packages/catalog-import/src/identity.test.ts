import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  candidateGroupKey,
  candidateSkuKey,
  normalizeIdentifier,
  normalizeStoreKey,
  sourceProductKey,
  sourceVariantKey,
} from './identity.ts';

// Named so the intent survives a reviewer skimming the assertions: literal
// invisible characters in a test file are indistinguishable from a typo.
const IDEOGRAPHIC_SPACE = '　';
const NO_BREAK_SPACE = ' ';
const ZERO_WIDTH_SPACE = '​';
const BOM = '﻿';

// --- normalizeIdentifier ----------------------------------------------------

test('trims surrounding whitespace without touching the interior', () => {
  assert.equal(normalizeIdentifier('  AB-12  '), 'ab-12');
  assert.equal(normalizeIdentifier('\tAB-12\n'), 'ab-12');
});

test('trims unicode spaces the workbook carries from a CJK ERP export', () => {
  assert.equal(normalizeIdentifier(`${IDEOGRAPHIC_SPACE}AB-12${NO_BREAK_SPACE}`), 'ab-12');
  assert.equal(normalizeIdentifier(`${BOM}AB-12${ZERO_WIDTH_SPACE}`), 'ab-12');
});

test('collapses interior whitespace runs so double-space typos still match', () => {
  assert.equal(normalizeIdentifier('AB  12'), 'ab 12');
  assert.equal(normalizeIdentifier(`AB ${IDEOGRAPHIC_SPACE} 12`), 'ab 12');
});

test('casefolds so store-entered case variants resolve to one variant', () => {
  assert.equal(normalizeIdentifier('Ab-12'), normalizeIdentifier('aB-12'));
});

test('NFKC-folds full-width characters emitted by Chinese tooling', () => {
  assert.equal(normalizeIdentifier('ＡＢ－１２'), 'ab-12');
});

test('keeps numeric-looking SKUs as strings and preserves leading zeros', () => {
  assert.equal(normalizeIdentifier('0012300'), '0012300');
  assert.equal(normalizeIdentifier('000'), '000');
  // The value must never round-trip through Number(): 1e5 is a distinct SKU
  // from 100000, and 0.30 must not collapse to 0.3.
  assert.equal(normalizeIdentifier('1e5'), '1e5');
  assert.equal(normalizeIdentifier('0.30'), '0.30');
});

test('strips control characters that would corrupt a key', () => {
  assert.equal(normalizeIdentifier('AB\u0001-12'), 'ab-12');
  assert.equal(normalizeIdentifier('AB\u007F-12'), 'ab-12');
  // A newline inside a cell is whitespace, not a separator: it collapses.
  assert.equal(normalizeIdentifier('AB\n12'), 'ab 12');
});

test('returns null for absent or blank identifiers rather than an empty key', () => {
  assert.equal(normalizeIdentifier(''), null);
  assert.equal(normalizeIdentifier('   '), null);
  assert.equal(normalizeIdentifier(`${IDEOGRAPHIC_SPACE}${ZERO_WIDTH_SPACE}`), null);
  assert.equal(normalizeIdentifier(undefined), null);
  assert.equal(normalizeIdentifier(null), null);
});

test('refuses non-string input instead of coercing it', () => {
  assert.equal(normalizeIdentifier(12345 as unknown as string), null);
  assert.equal(normalizeIdentifier(new Date() as unknown as string), null);
});

// --- store keys -------------------------------------------------------------

test('normalizes store names the same way as identifiers', () => {
  assert.equal(normalizeStoreKey('  My Store_MY '), 'my store_my');
});

// --- deterministic source keys ---------------------------------------------

test('builds the documented source product and variant keys', () => {
  assert.equal(
    sourceProductKey({ provider: 'dianxiaomi', taxonomy: 'lazada', store: 'Shop A', value: 'P-1' }),
    'dianxiaomi:lazada:shop a:p-1',
  );
  assert.equal(
    sourceVariantKey({ provider: 'dianxiaomi', taxonomy: 'lazada', store: 'Shop A', value: 'S-1' }),
    'dianxiaomi:lazada:shop a:s-1',
  );
});

test('builds the documented candidate keys without a store segment', () => {
  assert.equal(candidateGroupKey('dianxiaomi', ' P-1 '), 'dianxiaomi:p-1');
  assert.equal(candidateSkuKey('dianxiaomi', ' S-1 '), 'dianxiaomi:s-1');
});

test('source keys are stable across whitespace, case and full-width variants', () => {
  const a = sourceProductKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: 'Shop A',
    value: 'P-1',
  });
  const b = sourceProductKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: ' shop  a ',
    value: 'Ｐ-１',
  });
  assert.equal(a, b);
});

test('escapes separators so segment boundaries cannot be forged', () => {
  // Without escaping, ("a:b","c") and ("a","b:c") would collide on one key and
  // two unrelated stores' SKUs would merge into one website variant.
  const forged = sourceVariantKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: 'a:b',
    value: 'c',
  });
  const plain = sourceVariantKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: 'a',
    value: 'b:c',
  });
  assert.notEqual(forged, plain);
});

test('escapes the escape character itself', () => {
  const a = sourceVariantKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: 'a%3ab',
    value: 'c',
  });
  const b = sourceVariantKey({
    provider: 'dianxiaomi',
    taxonomy: 'lazada',
    store: 'a:b',
    value: 'c',
  });
  assert.notEqual(a, b);
});

test('rejects a key built from a blank identifier', () => {
  assert.equal(
    sourceProductKey({ provider: 'dianxiaomi', taxonomy: 'lazada', store: 'x', value: '  ' }),
    null,
  );
  assert.equal(candidateGroupKey('dianxiaomi', ''), null);
});

test('keeps an empty store segment when the store is unknown', () => {
  assert.equal(
    sourceProductKey({ provider: 'dianxiaomi', taxonomy: 'lazada', store: '', value: 'P-1' }),
    'dianxiaomi:lazada::p-1',
  );
});
