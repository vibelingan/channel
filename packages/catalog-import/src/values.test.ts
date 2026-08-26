import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  OPEN_ENDED_DATE_SENTINEL,
  dedupeImageUrls,
  excelSerialToNaiveDateTime,
  parseSourceDate,
  parseSourceMoney,
  parseSourceQuantity,
  parseSourceUrl,
} from './values.ts';

// --- money ------------------------------------------------------------------

test('parses integer and two-decimal money exactly', () => {
  assert.deepEqual(parseSourceMoney('1299'), { ok: true, amountMinor: 129900, rounded: false });
  assert.deepEqual(parseSourceMoney('1299.00'), { ok: true, amountMinor: 129900, rounded: false });
  assert.deepEqual(parseSourceMoney('0.01'), { ok: true, amountMinor: 1, rounded: false });
  assert.deepEqual(parseSourceMoney('0'), { ok: true, amountMinor: 0, rounded: false });
});

test('parses money without binary float error', () => {
  // Number('1.15') * 100 === 114.99999999999999.
  assert.deepEqual(parseSourceMoney('1.15'), { ok: true, amountMinor: 115, rounded: false });
  assert.deepEqual(parseSourceMoney('19.99'), { ok: true, amountMinor: 1999, rounded: false });
  assert.deepEqual(parseSourceMoney('0.29'), { ok: true, amountMinor: 29, rounded: false });
});

test('tolerates the float noise a spreadsheet stores for an exact price', () => {
  // Excel writes 1299.0000000000001 for a cell the merchant typed as 1299.
  assert.deepEqual(parseSourceMoney('1299.0000000000001'), {
    ok: true,
    amountMinor: 129900,
    rounded: true,
  });
  assert.deepEqual(parseSourceMoney('19.990000'), { ok: true, amountMinor: 1999, rounded: false });
});

test('rounds a genuinely sub-fen price half-up and says that it rounded', () => {
  assert.deepEqual(parseSourceMoney('19.995'), { ok: true, amountMinor: 2000, rounded: true });
  assert.deepEqual(parseSourceMoney('19.994'), { ok: true, amountMinor: 1999, rounded: true });
});

test('strips grouping separators and surrounding whitespace', () => {
  assert.deepEqual(parseSourceMoney(' 1,299.00 '), {
    ok: true,
    amountMinor: 129900,
    rounded: false,
  });
});

test('rejects money that is not a plain non-negative decimal', () => {
  for (const raw of [
    '',
    '   ',
    'abc',
    '12abc',
    '-1',
    '-0.01',
    '1.2E3',
    '1..2',
    '.',
    '+1',
    '１２３４',
  ]) {
    assert.equal(parseSourceMoney(raw).ok, false, `expected rejection for ${JSON.stringify(raw)}`);
  }
});

test('refuses non-string money input rather than coercing it', () => {
  assert.equal(parseSourceMoney(undefined).ok, false);
  assert.equal(parseSourceMoney(1299 as unknown as string).ok, false);
});

test('rejects money too large to hold exactly as minor units', () => {
  assert.equal(parseSourceMoney('999999999999999999').ok, false);
});

// --- quantity ---------------------------------------------------------------

test('parses non-negative integer stock', () => {
  assert.deepEqual(parseSourceQuantity('0'), { ok: true, quantity: 0 });
  assert.deepEqual(parseSourceQuantity('42'), { ok: true, quantity: 42 });
  assert.deepEqual(parseSourceQuantity(' 42 '), { ok: true, quantity: 42 });
  // A spreadsheet stores an integer cell as `42.0`.
  assert.deepEqual(parseSourceQuantity('42.0'), { ok: true, quantity: 42 });
  assert.deepEqual(parseSourceQuantity('42.000000'), { ok: true, quantity: 42 });
});

test('rejects fractional, negative and non-numeric stock instead of zeroing it', () => {
  for (const raw of ['', '  ', '-1', '4.5', 'abc', 'N/A', '1e3', '4,2']) {
    assert.equal(
      parseSourceQuantity(raw).ok,
      false,
      `expected rejection for ${JSON.stringify(raw)}`,
    );
  }
});

// --- dates ------------------------------------------------------------------

test('reads a naive workbook timestamp as UTC+8', () => {
  const result = parseSourceDate('2026-08-26 11:25:04');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.iso, '2026-08-26T03:25:04.000Z');
    assert.equal(result.source, '2026-08-26 11:25:04');
    assert.equal(result.openEnded, false);
  }
});

test('accepts a date without a time component', () => {
  const result = parseSourceDate('2026-08-26');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.iso, '2026-08-25T16:00:00.000Z');
});

test('accepts slash-separated dates', () => {
  const result = parseSourceDate('2026/08/26 11:25:04');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.iso, '2026-08-26T03:25:04.000Z');
});

test('flags the open-ended promotion sentinel instead of showing it to customers', () => {
  const result = parseSourceDate(OPEN_ENDED_DATE_SENTINEL);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.openEnded, true);
    assert.equal(result.source, OPEN_ENDED_DATE_SENTINEL);
  }
});

test('preserves the original cell representation on every parsed date', () => {
  const result = parseSourceDate(' 2026/08/26 ');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.source, '2026/08/26');
});

test('rejects impossible and unparseable dates rather than inventing one', () => {
  for (const raw of [
    '',
    'not a date',
    '2026-13-01',
    '2026-02-30',
    '2026-08-26 25:00:00',
    '0000-00-00',
  ]) {
    assert.equal(parseSourceDate(raw).ok, false, `expected rejection for ${JSON.stringify(raw)}`);
  }
});

test('converts an Excel serial date to a naive timestamp', () => {
  // Serial 1 is 1900-01-01 in Excel's (deliberately wrong) 1900 calendar.
  assert.equal(excelSerialToNaiveDateTime(1), '1900-01-01 00:00:00');
  // Serial 60 is Excel's phantom 1900-02-29; 61 must still be 1900-03-01.
  assert.equal(excelSerialToNaiveDateTime(61), '1900-03-01 00:00:00');
  assert.equal(excelSerialToNaiveDateTime(46260), '2026-08-26 00:00:00');
  assert.equal(excelSerialToNaiveDateTime(46260.5), '2026-08-26 12:00:00');
  assert.equal(excelSerialToNaiveDateTime(0), null);
  assert.equal(excelSerialToNaiveDateTime(Number.NaN), null);
});

// --- image URLs -------------------------------------------------------------

test('accepts http and https image URLs', () => {
  assert.equal(parseSourceUrl(' https://cdn.example/a.jpg '), 'https://cdn.example/a.jpg');
  assert.equal(parseSourceUrl('http://cdn.example/a.jpg'), 'http://cdn.example/a.jpg');
});

test('rejects non-http schemes and malformed URLs', () => {
  for (const raw of [
    '',
    'not a url',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///etc/passwd',
    'ftp://x/y.png',
    '//cdn.example/a.jpg',
  ]) {
    assert.equal(parseSourceUrl(raw), null, `expected rejection for ${JSON.stringify(raw)}`);
  }
});

test('deduplicates image URLs while preserving first-seen order', () => {
  assert.deepEqual(
    dedupeImageUrls([
      'https://cdn.example/b.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ]),
    ['https://cdn.example/b.jpg', 'https://cdn.example/a.jpg'],
  );
});

test('treats URLs differing only in case of scheme and host as one image', () => {
  assert.deepEqual(dedupeImageUrls(['https://CDN.Example/a.jpg', 'https://cdn.example/a.jpg']), [
    'https://CDN.Example/a.jpg',
  ]);
});

test('keeps URLs whose paths differ in case as separate images', () => {
  // Path case is significant on almost every object store.
  assert.equal(
    dedupeImageUrls(['https://cdn.example/A.jpg', 'https://cdn.example/a.jpg']).length,
    2,
  );
});
