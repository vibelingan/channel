import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { buildNonSpreadsheetZip, buildXlsx } from './testing/xlsx-fixture.ts';
import {
  SpreadsheetFormatError,
  columnIndexFromReference,
  looksLikeSpreadsheet,
  readFirstSheet,
  scanXml,
} from './xlsx-sheet.ts';
import { ZipArchive, ZipFormatError, looksLikeZip } from './xlsx-zip.ts';

const sheet = (rows: readonly (readonly (string | number | null)[])[]) =>
  buildXlsx({ sheets: [{ name: 'Sheet1', rows }] });

const textOf = (bytes: Buffer) =>
  readFirstSheet(bytes).rows.map((row) => row.cells.map((cell) => cell?.text ?? null));

// --- container --------------------------------------------------------------

test('reads a deflated workbook, which is what Excel writes', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['a', 'b']] }], compress: true });
  assert.deepEqual(textOf(bytes), [['a', 'b']]);
});

test('reads a stored (uncompressed) workbook', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['a', 'b']] }], compress: false });
  assert.deepEqual(textOf(bytes), [['a', 'b']]);
});

test('detects a workbook by content, not by filename', () => {
  assert.equal(looksLikeSpreadsheet(sheet([['a']])), true);
  // A perfectly valid ZIP that is not a spreadsheet.
  assert.equal(looksLikeSpreadsheet(buildNonSpreadsheetZip()), false);
  assert.equal(looksLikeSpreadsheet(Buffer.from('PK not really a zip', 'utf8')), false);
  assert.equal(looksLikeSpreadsheet(Buffer.alloc(0)), false);
  assert.equal(looksLikeZip(Buffer.from('%PDF-1.7', 'utf8')), false);
});

test('rejects a truncated archive rather than returning partial rows', () => {
  const bytes = sheet([['a']]);
  assert.throws(() => readFirstSheet(bytes.subarray(0, bytes.length - 40)), SpreadsheetFormatError);
});

test('rejects an archive whose entry fails its CRC check', () => {
  const bytes = Buffer.from(sheet([['abcdefgh']]));
  // Flip a byte inside the first entry's payload. The local header is 30 bytes
  // plus the name, so this lands in compressed data, not in metadata.
  const target = 30 + '[Content_Types].xml'.length + 4;
  bytes[target] = (bytes[target] as number) ^ 0xff;
  assert.throws(() => new ZipArchive(bytes).read('[Content_Types].xml'), ZipFormatError);
});

test('rejects an unsupported compression method', () => {
  const bytes = Buffer.from(sheet([['a']]));
  // Method lives at local+8 and central+10; corrupt the local copy only, which
  // is enough because read() consults the central directory for the method.
  const directory = new ZipArchive(bytes);
  assert.ok(directory.has('xl/workbook.xml'));
  // Rewrite every central-directory method field to 99 (unassigned).
  for (let index = 0; index < bytes.length - 4; index += 1) {
    if (bytes.readUInt32LE(index) === 0x02014b50) bytes.writeUInt16LE(99, index + 10);
  }
  assert.throws(() => new ZipArchive(bytes).read('xl/workbook.xml'), ZipFormatError);
});

test('refuses a workbook that uses the 1904 date system', () => {
  // Every serial in a 1904 workbook is 1,462 days from its 1900 reading — four
  // years and a day. A silently mis-read date is worse than a refused file.
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [[{ dateSerial: 46260 }]] }],
    date1904: true,
  });
  assert.throws(
    () => readFirstSheet(bytes),
    (error: unknown) => error instanceof SpreadsheetFormatError && /1904/.test(error.message),
  );
  // The same workbook without the flag reads normally.
  const ok = buildXlsx({ sheets: [{ name: 'S', rows: [[{ dateSerial: 46260 }]] }] });
  assert.equal(readFirstSheet(ok).rows[0]?.cells[0]?.text, '46260');
});

// --- XML safety -------------------------------------------------------------

test('refuses spreadsheet XML that declares a DTD', () => {
  const hostile =
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "boom">]><worksheet><sheetData/></worksheet>';
  assert.throws(() => [...scanXml(hostile)], SpreadsheetFormatError);
});

test('never lets an attribute name reach Object.prototype', () => {
  const events = [...scanXml('<c __proto__="polluted" constructor="x"><v>1</v></c>')];
  const open = events.find((event) => event.type === 'open');
  assert.ok(open && open.type === 'open');
  assert.equal(open.attrs.get('__proto__'), 'polluted');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('decodes only the predefined entities and character references', () => {
  const events = [...scanXml('<t>a&amp;b &lt;c&gt; &#65; &#x42; &unknown;</t>')];
  const text = events
    .filter((event) => event.type === 'text')
    .map((event) => (event.type === 'text' ? event.text : ''))
    .join('');
  assert.equal(text, 'a&b <c> A B &unknown;');
});

// --- cell fidelity ----------------------------------------------------------

test('carries numeric cells as their stored lexeme, never as a number', () => {
  const bytes = buildXlsx({
    sheets: [
      { name: 'S', rows: [[{ inline: '0012300' }, { inline: '1e5' }, { numeric: '19.9900' }]] },
    ],
  });
  const rows = readFirstSheet(bytes).rows;
  const cells = rows[0]?.cells ?? [];
  assert.equal(cells[0]?.text, '0012300');
  assert.equal(cells[0]?.kind, 'text');
  assert.equal(cells[1]?.text, '1e5');
  assert.equal(cells[2]?.text, '19.9900');
  assert.equal(cells[2]?.kind, 'number');
  assert.equal(typeof cells[2]?.text, 'string');
});

test('reads boolean and error cell forms from the generated workbook', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [[{ boolean: true }, { boolean: false }, { error: '#DIV/0!' }]] }],
  });
  const cells = readFirstSheet(bytes).rows[0]?.cells ?? [];
  assert.deepEqual(cells, [
    { text: 'TRUE', kind: 'boolean', dateFormatted: false },
    { text: 'FALSE', kind: 'boolean', dateFormatted: false },
    { text: '#DIV/0!', kind: 'error', dateFormatted: false },
  ]);
});

test('reads shared, inline and formula-result strings alike', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [['shared', { inline: 'inline' }, { formula: 'computed' }]] }],
  });
  assert.deepEqual(textOf(bytes), [['shared', 'inline', 'computed']]);
});

test('reuses the shared-string table across repeated values', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['same'], ['same'], ['other']] }] });
  assert.deepEqual(textOf(bytes), [['same'], ['same'], ['other']]);
});

test('marks date-formatted numbers so a serial is not mistaken for a count', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [[{ dateSerial: 46260 }, 46260]] }] });
  const cells = readFirstSheet(bytes).rows[0]?.cells ?? [];
  assert.equal(cells[0]?.dateFormatted, true);
  assert.equal(cells[0]?.text, '46260');
  assert.equal(cells[1]?.dateFormatted, false);
});

test('recognizes every CJK built-in date format retained from the Chinese ERP reader', () => {
  const formatIds = [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58];
  const bytes = buildXlsx({
    sheets: [
      {
        name: 'S',
        rows: [formatIds.map((numFmtId) => ({ dateSerial: 46260, numFmtId }))],
      },
    ],
  });
  const cells = readFirstSheet(bytes).rows[0]?.cells ?? [];
  assert.equal(cells.length, formatIds.length);
  assert.deepEqual(
    cells.map((cell) => ({
      text: cell?.text,
      kind: cell?.kind,
      dateFormatted: cell?.dateFormatted,
    })),
    formatIds.map(() => ({ text: '46260', kind: 'number', dateFormatted: true })),
  );
});

test('preserves ECMA-376 ISO date cells as their original timestamp text', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [[{ isoDate: '2026-08-29T10:30:00' }]] }],
  });
  assert.deepEqual(readFirstSheet(bytes).rows[0]?.cells[0], {
    text: '2026-08-29T10:30:00',
    kind: 'text',
    dateFormatted: true,
  });
});

test('reports malformed shared-string references without leaking a SheetJS TypeError', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [[{ sharedStringIndex: 99 }]] }],
  });
  assert.throws(
    () => readFirstSheet(bytes),
    (error: unknown) =>
      error instanceof SpreadsheetFormatError &&
      error.message === 'SheetJS could not parse workbook',
  );
});

test('preserves row numbers and leaves gaps for empty cells', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['a', null, 'c'], [], ['d']] }] });
  const parsed = readFirstSheet(bytes);
  assert.deepEqual(
    parsed.rows.map((row) => row.rowNumber),
    [1, 2, 3],
  );
  assert.equal(parsed.rows[0]?.cells[0]?.text, 'a');
  assert.equal(parsed.rows[0]?.cells[1], undefined);
  assert.equal(parsed.rows[0]?.cells[2]?.text, 'c');
  assert.deepEqual(parsed.rows[1]?.cells, []);
});

test('preserves the sheet name', () => {
  assert.equal(
    readFirstSheet(buildXlsx({ sheets: [{ name: '全球产品', rows: [['a']] }] })).name,
    '全球产品',
  );
});

test('reads only the first worksheet', () => {
  const bytes = buildXlsx({
    sheets: [
      { name: 'First', rows: [['a']] },
      { name: 'Second', rows: [['b']] },
    ],
  });
  const parsed = readFirstSheet(bytes);
  assert.equal(parsed.name, 'First');
  assert.deepEqual(
    parsed.rows.map((row) => row.cells[0]?.text),
    ['a'],
  );
});

test('round-trips CJK text and characters that need Excel escaping', () => {
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: [['蓝牙耳机 5.3', 'a & b < c', ' padded ']] }],
  });
  assert.deepEqual(textOf(bytes), [['蓝牙耳机 5.3', 'a & b < c', ' padded ']]);
});

// --- column references ------------------------------------------------------

test('converts spreadsheet column references to zero-based indices', () => {
  assert.equal(columnIndexFromReference('A1'), 0);
  assert.equal(columnIndexFromReference('B7'), 1);
  assert.equal(columnIndexFromReference('Z1'), 25);
  assert.equal(columnIndexFromReference('AA1'), 26);
  assert.equal(columnIndexFromReference('AR312'), 43);
  assert.equal(columnIndexFromReference('123'), -1);
  assert.equal(columnIndexFromReference(''), -1);
});
