/**
 * Builds genuine `.xlsx` bytes in memory, for tests and for the local
 * acceptance fixtures.
 *
 * Fixtures are GENERATED rather than committed as binaries. A checked-in
 * spreadsheet is unreviewable — a reviewer cannot see that row 7 has a
 * trailing space in its SKU without opening Excel — whereas the fixture
 * definitions below read as ordinary code and diff like ordinary code. It also
 * removes any chance of committing customer data by mistake.
 *
 * The writer emits both stored and deflated entries so the reader is exercised
 * against both compression methods that Excel itself produces.
 */
import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../xlsx-zip.ts';

const SIGNATURE_LOCAL = 0x04034b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_EOCD = 0x06054b50;
const VERSION_NEEDED = 20;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Fixed DOS timestamp so identical fixtures hash identically across runs. */
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2000-01-01

interface PendingEntry {
  name: string;
  data: Buffer;
}

function zipBytes(entries: readonly PendingEntry[], compress: boolean): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const stored = compress ? deflateRawSync(entry.data) : entry.data;
    const method = compress ? METHOD_DEFLATE : METHOD_STORED;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(SIGNATURE_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, stored);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(SIGNATURE_CENTRAL, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIGNATURE_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, eocd]);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A date-formatted number: the workbook stores an Excel serial, not text. */
export interface DateSerialCell {
  dateSerial: number;
}
/** A string stored in the cell itself rather than the shared-string table. */
export interface InlineStringCell {
  inline: string;
}
/** A cell whose value came from a formula (`t="str"`). */
export interface FormulaStringCell {
  formula: string;
}

export type FixtureCell =
  | string
  | number
  | null
  | undefined
  | DateSerialCell
  | InlineStringCell
  | FormulaStringCell;

export interface FixtureSheet {
  name: string;
  rows: readonly (readonly FixtureCell[])[];
}

export interface FixtureOptions {
  sheets: readonly FixtureSheet[];
  /** Deflate entries (what Excel does) instead of storing them. */
  compress?: boolean;
}

function columnName(index: number): string {
  let name = '';
  let remaining = index;
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

function isDateSerial(cell: FixtureCell): cell is DateSerialCell {
  return typeof cell === 'object' && cell !== null && 'dateSerial' in cell;
}
function isInline(cell: FixtureCell): cell is InlineStringCell {
  return typeof cell === 'object' && cell !== null && 'inline' in cell;
}
function isFormula(cell: FixtureCell): cell is FormulaStringCell {
  return typeof cell === 'object' && cell !== null && 'formula' in cell;
}

/** Build a complete, Excel-readable `.xlsx` from plain cell values. */
export function buildXlsx(options: FixtureOptions): Buffer {
  const sharedStrings: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const next = sharedStrings.length;
    sharedStrings.push(value);
    sharedIndex.set(value, next);
    return next;
  };

  const sheetParts = options.sheets.map((sheet) => {
    const rowsXml = sheet.rows
      .map((row, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cells = row
          .map((cell, columnIndex) => {
            if (cell === null || cell === undefined || cell === '') return '';
            const reference = `${columnName(columnIndex)}${rowNumber}`;
            if (isDateSerial(cell)) {
              return `<c r="${reference}" s="1"><v>${cell.dateSerial}</v></c>`;
            }
            if (isInline(cell)) {
              return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(cell.inline)}</t></is></c>`;
            }
            if (isFormula(cell)) {
              return `<c r="${reference}" t="str"><f>A1</f><v>${escapeXml(cell.formula)}</v></c>`;
            }
            if (typeof cell === 'number') {
              return `<c r="${reference}"><v>${cell}</v></c>`;
            }
            return `<c r="${reference}" t="s"><v>${intern(cell)}</v></c>`;
          })
          .join('');
        return `<row r="${rowNumber}">${cells}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
  });

  const sheetTags = options.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${options.sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rIdShared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings
    .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
    .join('')}</sst>`;

  // cellXfs index 0 is General; index 1 uses built-in numFmt 14 (a date), which
  // is what tells the reader to treat the serial in that cell as a timestamp.
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" applyNumberFormat="1" xfId="0"/><xf numFmtId="176" applyNumberFormat="1" xfId="0"/></cellXfs></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const entries: PendingEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(stylesXml, 'utf8') },
    ...sheetParts.map((xml, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(xml, 'utf8'),
    })),
  ];

  return zipBytes(entries, options.compress ?? true);
}

/** Build a ZIP that is not an `.xlsx` — used to prove detection is by content. */
export function buildNonSpreadsheetZip(): Buffer {
  return zipBytes([{ name: 'readme.txt', data: Buffer.from('not a workbook', 'utf8') }], true);
}
