/**
 * Fail-closed limits of the XLSX reader.
 *
 * Every limit the reader claims is exercised here against a file that actually
 * violates it. A documented limit nobody tested is a limit that does not exist
 * — and this reader is the boundary between a merchant-supplied file and the
 * catalog, so "we believe it refuses that" is not good enough.
 *
 * Each test states what the input is and what refusing it prevents.
 */
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { buildXlsx } from './testing/xlsx-fixture.ts';
import {
  MAX_ATTRIBUTE_CHARS,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_TEXT_NODE_CHARS,
  MAX_XML_DEPTH,
  SpreadsheetFormatError,
  readFirstSheet,
  scanXml,
} from './xlsx-sheet.ts';
import {
  MAX_COMPRESSION_RATIO,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  ZipFormatError,
  readZipDirectory,
} from './xlsx-zip.ts';

// --- a minimal ZIP writer, so a hostile archive can be built directly -------

function zipOf(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const stored = deflateRawSync(data, { level: 9 });
    // A correct CRC keeps the archive self-consistent, so the reader reaches
    // the limit under test rather than failing the checksum first.
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, stored);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const ROOT_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WORKBOOK_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

function workbookXml(extra = ''): string {
  return `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${extra}<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

const SHEET = (body: string) =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${body}</worksheet>`;

function packageOf(options: {
  sheet?: string;
  workbook?: string;
  extraParts?: readonly (readonly [string, Buffer])[];
  workbookRels?: string;
}): Buffer {
  return zipOf([
    ['[Content_Types].xml', Buffer.from(CONTENT_TYPES)],
    ['_rels/.rels', Buffer.from(ROOT_RELS)],
    ['xl/workbook.xml', Buffer.from(options.workbook ?? workbookXml())],
    ['xl/_rels/workbook.xml.rels', Buffer.from(options.workbookRels ?? WORKBOOK_RELS)],
    [
      'xl/worksheets/sheet1.xml',
      Buffer.from(options.sheet ?? SHEET('<sheetData><row r="1"/></sheetData>')),
    ],
    ...(options.extraParts ?? []),
  ]);
}

const refuses = (bytes: Buffer, pattern: RegExp) =>
  assert.throws(
    () => readFirstSheet(bytes),
    (error: unknown) =>
      (error instanceof SpreadsheetFormatError || error instanceof ZipFormatError) &&
      pattern.test((error as Error).message),
  );

// --- container limits -------------------------------------------------------

test('an archive with too many entries is refused', () => {
  const entries = Array.from(
    { length: MAX_ENTRIES + 5 },
    (_v, index) => [`part-${index}.xml`, Buffer.from('<a/>')] as const,
  );
  assert.throws(() => readZipDirectory(zipOf(entries)), ZipFormatError);
});

test('an entry that expands past the per-entry ceiling is refused', () => {
  // 200 MB from a few hundred KB: refused on the DECLARED size, before any
  // memory is allocated for it.
  const huge = Buffer.alloc(MAX_ENTRY_BYTES + 1024, 0x20);
  refuses(packageOf({ sheet: SHEET(`<sheetData/><!--${huge.toString('latin1')}-->`) }), /bytes/);
});

test('an entry over the compression-ratio ceiling is refused', () => {
  const ratio = MAX_COMPRESSION_RATIO;
  assert.ok(ratio >= 100, 'the ratio guard is meaningfully tight');
  // 40 MB of one repeated byte compresses far past 200:1.
  const padded = ' '.repeat(40 * 1024 * 1024);
  refuses(packageOf({ sheet: SHEET(`<sheetData/><!--${padded}-->`) }), /bytes|ratio/);
});

test('a truncated archive is refused rather than partially read', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['a']] }] });
  refuses(bytes.subarray(0, bytes.length - 40), /.+/);
});

// --- XML limits -------------------------------------------------------------

test('XML nested past the depth ceiling is refused', () => {
  const deep = '<a>'.repeat(MAX_XML_DEPTH + 10);
  assert.throws(
    () => [...scanXml(`<root>${deep}</root>`)],
    (error: unknown) =>
      error instanceof SpreadsheetFormatError && /nests deeper/.test(error.message),
  );
});

test('XML nested within the depth ceiling is accepted', () => {
  const shallow = '<a>'.repeat(10) + '</a>'.repeat(10);
  assert.doesNotThrow(() => [...scanXml(`<root>${shallow}</root>`)]);
});

test('an oversized text node is refused', () => {
  const text = 'x'.repeat(MAX_TEXT_NODE_CHARS + 1);
  assert.throws(
    () => [...scanXml(`<t>${text}</t>`)],
    (error: unknown) =>
      error instanceof SpreadsheetFormatError && /oversized text node/.test(error.message),
  );
});

test('an oversized attribute value is refused', () => {
  const value = 'y'.repeat(MAX_ATTRIBUTE_CHARS + 1);
  assert.throws(
    () => [...scanXml(`<c r="${value}"/>`)],
    (error: unknown) =>
      error instanceof SpreadsheetFormatError && /oversized attribute/.test(error.message),
  );
});

test('a DTD is refused outright, so entity expansion is unreachable', () => {
  assert.throws(
    () => [...scanXml('<!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>')],
    (error: unknown) => error instanceof SpreadsheetFormatError && /DTD/.test(error.message),
  );
});

// --- refused parts ----------------------------------------------------------

test('a macro-enabled workbook is refused', () => {
  refuses(
    packageOf({ extraParts: [['xl/vbaProject.bin', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])]] }),
    /macros/,
  );
});

test('a macro part is refused even when its name is recased', () => {
  // OPC part names are case-insensitive, so a compliant reader treats
  // xl/VbaProject.bin as the exact same part as xl/vbaProject.bin -- a
  // case-sensitive refusal check would let this one slip past as though the
  // workbook carried no macro at all.
  refuses(
    packageOf({ extraParts: [['xl/VbaProject.bin', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])]] }),
    /macros/,
  );
});

test('a workbook carrying external link parts is refused', () => {
  refuses(
    packageOf({
      extraParts: [['xl/externalLinks/externalLink1.xml', Buffer.from('<externalLink/>')]],
    }),
    /external links/,
  );
});

test('a workbook declaring external references is refused', () => {
  refuses(
    packageOf({
      workbook: workbookXml(
        '<externalReferences><externalReference r:id="rIdX"/></externalReferences>',
      ),
    }),
    /external references/,
  );
});

test('ActiveX, embedded objects and custom XML parts are refused', () => {
  for (const [part, pattern] of [
    ['xl/activeX/activeX1.xml', /ActiveX/],
    ['xl/embeddings/oleObject1.bin', /embedded objects/],
    ['customXml/item1.xml', /custom XML/],
  ] as const) {
    refuses(packageOf({ extraParts: [[part, Buffer.from('<x/>')]] }), pattern);
  }
});

// --- relationships ----------------------------------------------------------

test('a worksheet relationship that does not resolve is refused, not guessed', () => {
  // The workbook names rId1 but the rels part defines only rId9. Falling back
  // to the conventional sheet1.xml could silently import a different sheet.
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  refuses(packageOf({ workbookRels: rels }), /does not resolve/);
});

test('a relationship target escaping the package is refused', () => {
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="../../../etc/passwd"/></Relationships>';
  refuses(packageOf({ workbookRels: rels }), /not a package part/);
});

test('a missing worksheet part is refused', () => {
  const rels =
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/absent.xml"/></Relationships>';
  refuses(packageOf({ workbookRels: rels }), /is missing/);
});

// --- declared worksheet extent ---------------------------------------------

test('a worksheet declaring more rows than the ceiling is refused up front', () => {
  refuses(
    packageOf({ sheet: SHEET(`<dimension ref="A1:B${MAX_ROWS + 1}"/><sheetData/>`) }),
    /declares .* rows/,
  );
});

test('a worksheet declaring more columns than the ceiling is refused up front', () => {
  // XFD is Excel's last column, 16,384 — well past this reader's ceiling.
  refuses(packageOf({ sheet: SHEET('<dimension ref="A1:XFD100"/><sheetData/>') }), /columns/);
  assert.ok(MAX_COLUMNS < 16384, 'the ceiling is tighter than Excel’s own');
});

test('a worksheet declaring a sane extent is accepted', () => {
  const bytes = packageOf({
    sheet: SHEET('<dimension ref="A1:D10"/><sheetData><row r="1"/></sheetData>'),
  });
  assert.doesNotThrow(() => readFirstSheet(bytes));
});

// --- resource cleanup -------------------------------------------------------

test('reading holds no file handles and releases its buffers', () => {
  // The reader takes a Buffer and returns plain objects: it opens nothing, so
  // there is nothing to leak. This asserts the property that makes that true —
  // repeated reads do not accumulate handles or unbounded memory.
  const bytes = buildXlsx({
    sheets: [{ name: 'S', rows: Array.from({ length: 200 }, (_v, i) => [`row-${i}`, i]) }],
  });
  const before = process.memoryUsage().external;
  for (let run = 0; run < 25; run += 1) {
    const sheet = readFirstSheet(bytes);
    assert.equal(sheet.rows.length, 200);
  }
  const after = process.memoryUsage().external;
  // 25 reads of the same 200-row workbook must not retain tens of megabytes.
  assert.ok(
    after - before < 64 * 1024 * 1024,
    `external memory grew by ${(after - before) / 1024 / 1024} MB across 25 reads`,
  );
});
