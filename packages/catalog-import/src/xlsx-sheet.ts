/**
 * SpreadsheetML reading: `.xlsx` parts in, a grid of typed cells out.
 *
 * Two properties drive the whole design.
 *
 * FIDELITY. A numeric cell is carried as its stored LEXEME, never as a
 * JavaScript number. The workbook holds SKUs like `0012300` and `1e5`, and a
 * single `Number()` on the way through turns both into something else. The
 * caller decides what a lexeme means; this layer only reports what the file
 * said.
 *
 * SAFETY. The XML scanner refuses documents with a DTD outright and knows only
 * the five predefined entities plus numeric character references. There is no
 * entity table to expand, so XXE and billion-laughs are not mitigated here —
 * they are absent. Attributes are collected into a Map, not an object, so a
 * part containing `__proto__="…"` cannot reach Object.prototype (the same
 * class of defect as CVE-2023-30533 in the npm `xlsx` package).
 */
import type { Buffer } from 'node:buffer';
import { ZipArchive, ZipFormatError, looksLikeZip } from './xlsx-zip.ts';

/** A worksheet larger than this is not a Dianxiaomi product export. */
export const MAX_ROWS = 200_000;
/** Excel's own column ceiling is 16384; a product export uses tens. */
export const MAX_COLUMNS = 2_048;

export class SpreadsheetFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetFormatError';
  }
}

// ---------------------------------------------------------------------------
// XML scanning
// ---------------------------------------------------------------------------

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const XML_NAME_START = /[A-Za-z_]/;
const XML_NAME_CHAR = /[A-Za-z0-9_.:-]/;

function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos);/g,
    (whole, body: string) => {
      switch (body) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          break;
      }
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}

/** `x:row` and `row` are the same element as far as this reader is concerned. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

export function* scanXml(xml: string): Generator<XmlEvent> {
  let index = 0;
  while (index < xml.length) {
    const next = xml.indexOf('<', index);
    if (next === -1) {
      const text = xml.slice(index);
      if (text !== '') yield { type: 'text', text: decodeXmlEntities(text) };
      return;
    }
    if (next > index) {
      yield { type: 'text', text: decodeXmlEntities(xml.slice(index, next)) };
    }

    if (xml.startsWith('<!--', next)) {
      const close = xml.indexOf('-->', next + 4);
      index = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', next)) {
      const close = xml.indexOf(']]>', next + 9);
      const end = close === -1 ? xml.length : close;
      yield { type: 'text', text: xml.slice(next + 9, end) };
      index = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', next) || xml.startsWith('<!doctype', next)) {
      // Refused rather than skipped: a spreadsheet part has no legitimate DTD,
      // and declining to parse one is what makes entity expansion impossible.
      throw new SpreadsheetFormatError('spreadsheet XML declares a DTD');
    }
    if (xml.startsWith('<?', next)) {
      const close = xml.indexOf('?>', next + 2);
      index = close === -1 ? xml.length : close + 2;
      continue;
    }

    let cursor = next + 1;
    const closing = xml[cursor] === '/';
    if (closing) cursor += 1;
    if (cursor >= xml.length || !XML_NAME_START.test(xml[cursor] as string)) {
      // A stray `<` in content: emit it and continue rather than derailing.
      yield { type: 'text', text: '<' };
      index = next + 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < xml.length && XML_NAME_CHAR.test(xml[cursor] as string)) cursor += 1;
    const name = localName(xml.slice(nameStart, cursor));

    if (closing) {
      const close = xml.indexOf('>', cursor);
      index = close === -1 ? xml.length : close + 1;
      yield { type: 'close', name };
      continue;
    }

    // Attributes are stored in a Map: an object keyed by attacker-controlled
    // names is how a spreadsheet part reaches Object.prototype.
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (cursor < xml.length) {
      while (cursor < xml.length && /\s/.test(xml[cursor] as string)) cursor += 1;
      if (cursor >= xml.length) break;
      if (xml[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (xml[cursor] === '/') {
        selfClosing = true;
        cursor += 1;
        continue;
      }
      if (!XML_NAME_START.test(xml[cursor] as string)) {
        cursor += 1;
        continue;
      }
      const attrStart = cursor;
      while (cursor < xml.length && XML_NAME_CHAR.test(xml[cursor] as string)) cursor += 1;
      const attrName = xml.slice(attrStart, cursor).toLowerCase();
      while (cursor < xml.length && /\s/.test(xml[cursor] as string)) cursor += 1;
      if (xml[cursor] !== '=') {
        attrs.set(attrName, '');
        continue;
      }
      cursor += 1;
      while (cursor < xml.length && /\s/.test(xml[cursor] as string)) cursor += 1;
      const quote = xml[cursor];
      if (quote !== '"' && quote !== "'") {
        const valueStart = cursor;
        while (cursor < xml.length && !/[\s>]/.test(xml[cursor] as string)) cursor += 1;
        attrs.set(attrName, decodeXmlEntities(xml.slice(valueStart, cursor)));
        continue;
      }
      cursor += 1;
      const valueStart = cursor;
      const valueEnd = xml.indexOf(quote, cursor);
      if (valueEnd === -1) {
        attrs.set(attrName, decodeXmlEntities(xml.slice(valueStart)));
        cursor = xml.length;
        break;
      }
      attrs.set(attrName, decodeXmlEntities(xml.slice(valueStart, valueEnd)));
      cursor = valueEnd + 1;
    }

    index = cursor;
    yield { type: 'open', name, attrs, selfClosing };
  }
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

/**
 * Excel escapes characters it cannot store literally as `_xHHHH_`. Decoding
 * has to run after entity decoding, and `_x005F_` is the escape for a literal
 * `_x`, so it is handled first to avoid decoding merchant text by accident.
 */
function decodeExcelEscapes(value: string): string {
  if (!value.includes('_x')) return value;
  return value
    .replace(/_x005F_(_x[0-9a-fA-F]{4}_)/g, '$1')
    .replace(/_x([0-9a-fA-F]{4})_/g, (whole, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    });
}

function parseSharedStrings(xml: string | null): string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  let current = '';
  let inItem = false;
  let collecting = false;
  let phoneticDepth = 0;

  for (const event of scanXml(xml)) {
    if (event.type === 'open') {
      if (event.name === 'si') {
        inItem = true;
        current = '';
      } else if (event.name === 'rph' || event.name === 'phoneticpr') {
        // Furigana annotations are not part of the string the merchant typed.
        if (!event.selfClosing) phoneticDepth += 1;
      } else if (event.name === 't' && inItem && phoneticDepth === 0) {
        collecting = true;
      }
    } else if (event.type === 'text') {
      if (collecting) current += event.text;
    } else if (event.type === 'close') {
      if (event.name === 't') collecting = false;
      else if (event.name === 'rph') phoneticDepth = Math.max(0, phoneticDepth - 1);
      else if (event.name === 'si') {
        strings.push(decodeExcelEscapes(current));
        inItem = false;
        current = '';
      }
    }
  }
  return strings;
}

/**
 * Built-in number-format ids that denote a date or time.
 *
 * 27–36 and 50–58 matter here specifically: those are the CJK date formats,
 * and this workbook comes out of a Chinese ERP. Omitting them would leave real
 * dates looking like five-digit integers.
 */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/** A custom format is a date format when a date/time token survives stripping. */
function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/_./g, '');
  return /[ymdhs]/i.test(stripped);
}

interface StyleTable {
  /** Style (cellXfs) indices whose number format is a date/time. */
  dateStyles: ReadonlySet<number>;
}

function parseStyles(xml: string | null): StyleTable {
  if (xml === null) return { dateStyles: new Set() };
  const customDateFormats = new Set<number>();
  const dateStyles = new Set<number>();
  let inCellXfs = false;
  let xfIndex = 0;

  for (const event of scanXml(xml)) {
    if (event.type === 'open') {
      if (event.name === 'numfmt') {
        const id = Number(event.attrs.get('numfmtid'));
        const code = event.attrs.get('formatcode') ?? '';
        if (Number.isFinite(id) && isDateFormatCode(code)) customDateFormats.add(id);
      } else if (event.name === 'cellxfs') {
        inCellXfs = true;
        xfIndex = 0;
      } else if (event.name === 'xf' && inCellXfs) {
        const id = Number(event.attrs.get('numfmtid') ?? '0');
        if (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id)) dateStyles.add(xfIndex);
        xfIndex += 1;
      }
    } else if (event.type === 'close' && event.name === 'cellxfs') {
      inCellXfs = false;
    }
  }
  return { dateStyles };
}

interface SheetRef {
  name: string;
  relationshipId: string;
}

function parseWorkbookSheets(xml: string): SheetRef[] {
  const sheets: SheetRef[] = [];
  for (const event of scanXml(xml)) {
    if (event.type === 'open' && event.name === 'sheet') {
      const name = event.attrs.get('name') ?? '';
      const relationshipId = event.attrs.get('r:id') ?? event.attrs.get('id') ?? '';
      sheets.push({ name, relationshipId });
    }
  }
  return sheets;
}

function parseRelationships(xml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (xml === null) return map;
  for (const event of scanXml(xml)) {
    if (event.type === 'open' && event.name === 'relationship') {
      const id = event.attrs.get('id');
      const target = event.attrs.get('target');
      if (id !== undefined && target !== undefined) map.set(id, target);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type SourceCellKind = 'text' | 'number' | 'boolean' | 'error';

export interface SourceCell {
  /** The stored lexeme, unconverted. For numbers this is the raw decimal. */
  text: string;
  kind: SourceCellKind;
  /** The cell's number format denotes a date or time. */
  dateFormatted: boolean;
}

export interface SourceRow {
  /** 1-based worksheet row number, preserved so findings can point at it. */
  rowNumber: number;
  /** Indexed by 0-based column; sparse rows leave gaps. */
  cells: (SourceCell | undefined)[];
}

export interface SourceSheet {
  name: string;
  rows: SourceRow[];
}

/** `B` -> 1, `AA` -> 26. Returns -1 for a reference that is not a column. */
export function columnIndexFromReference(reference: string): number {
  let index = 0;
  let seen = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
      seen += 1;
    } else if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
      seen += 1;
    } else {
      break;
    }
  }
  return seen === 0 ? -1 : index - 1;
}

function parseSheet(xml: string, name: string, shared: string[], styles: StyleTable): SourceSheet {
  const rows: SourceRow[] = [];
  let cells: (SourceCell | undefined)[] = [];
  let rowNumber = 0;
  let columnIndex = -1;
  let cellType = '';
  let styleIndex = 0;
  let value = '';
  let collecting: 'value' | 'inline' | null = null;
  let inCell = false;
  let inInlineString = false;

  for (const event of scanXml(xml)) {
    if (event.type === 'open') {
      switch (event.name) {
        case 'row': {
          const declared = Number(event.attrs.get('r'));
          rowNumber = Number.isFinite(declared) && declared > 0 ? declared : rowNumber + 1;
          cells = [];
          columnIndex = -1;
          if (rows.length >= MAX_ROWS) {
            throw new SpreadsheetFormatError(`worksheet exceeds the ${MAX_ROWS}-row limit`);
          }
          break;
        }
        case 'c': {
          const reference = event.attrs.get('r') ?? '';
          const parsed = columnIndexFromReference(reference);
          columnIndex = parsed >= 0 ? parsed : columnIndex + 1;
          if (columnIndex >= MAX_COLUMNS) {
            throw new SpreadsheetFormatError(`worksheet exceeds the ${MAX_COLUMNS}-column limit`);
          }
          cellType = event.attrs.get('t') ?? 'n';
          styleIndex = Number(event.attrs.get('s') ?? '0');
          value = '';
          inCell = true;
          inInlineString = false;
          collecting = null;
          break;
        }
        case 'is':
          if (inCell) inInlineString = true;
          break;
        case 'v':
          if (inCell) collecting = 'value';
          break;
        case 't':
          if (inCell && inInlineString) collecting = 'inline';
          break;
        default:
          // <f> (the formula source) and everything else contribute no value.
          break;
      }
      continue;
    }

    if (event.type === 'text') {
      if (inCell && collecting !== null) value += event.text;
      continue;
    }

    switch (event.name) {
      case 'v':
      case 't':
        collecting = null;
        break;
      case 'is':
        inInlineString = false;
        break;
      case 'c': {
        if (inCell && value !== '') {
          cells[columnIndex] = buildCell(cellType, value, styleIndex, shared, styles);
        }
        inCell = false;
        break;
      }
      case 'row':
        if (rowNumber > 0) rows.push({ rowNumber, cells });
        break;
      default:
        break;
    }
  }

  return { name, rows };
}

function buildCell(
  cellType: string,
  raw: string,
  styleIndex: number,
  shared: string[],
  styles: StyleTable,
): SourceCell {
  switch (cellType) {
    case 's': {
      const index = Number(raw);
      const text = Number.isInteger(index) && index >= 0 ? (shared[index] ?? '') : '';
      return { text, kind: 'text', dateFormatted: false };
    }
    case 'inlineStr':
    case 'str':
      return { text: decodeExcelEscapes(raw), kind: 'text', dateFormatted: false };
    case 'b':
      return { text: raw === '1' ? 'TRUE' : 'FALSE', kind: 'boolean', dateFormatted: false };
    case 'e':
      return { text: raw, kind: 'error', dateFormatted: false };
    case 'd':
      // ECMA-376 2nd edition ISO date cell: already a timestamp, not a serial.
      return { text: raw, kind: 'text', dateFormatted: true };
    default:
      return { text: raw, kind: 'number', dateFormatted: styles.dateStyles.has(styleIndex) };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** True when the bytes are a ZIP that carries the OOXML spreadsheet parts. */
export function looksLikeSpreadsheet(bytes: Buffer): boolean {
  if (!looksLikeZip(bytes)) return false;
  try {
    const archive = new ZipArchive(bytes);
    return archive.has('xl/workbook.xml') && archive.has('[Content_Types].xml');
  } catch {
    return false;
  }
}

/**
 * Read the first worksheet of an `.xlsx`. The Dianxiaomi export is a
 * single-sheet file; reading only the first sheet keeps a multi-sheet file
 * from silently contributing rows nobody reviewed.
 */
export function readFirstSheet(bytes: Buffer): SourceSheet {
  let archive: ZipArchive;
  try {
    archive = new ZipArchive(bytes);
  } catch (error) {
    if (error instanceof ZipFormatError) throw new SpreadsheetFormatError(error.message);
    throw error;
  }

  const workbookXml = archive.readText('xl/workbook.xml');
  if (workbookXml === null) throw new SpreadsheetFormatError('workbook part is missing');

  const sheets = parseWorkbookSheets(workbookXml);
  const first = sheets[0];
  if (first === undefined) throw new SpreadsheetFormatError('workbook declares no worksheets');

  const rels = parseRelationships(archive.readText('xl/_rels/workbook.xml.rels'));
  const target = rels.get(first.relationshipId) ?? 'worksheets/sheet1.xml';
  const path = target.startsWith('/')
    ? target.slice(1)
    : target.startsWith('xl/')
      ? target
      : `xl/${target}`;

  const sheetXml = archive.readText(path);
  if (sheetXml === null) throw new SpreadsheetFormatError(`worksheet part ${path} is missing`);

  const shared = parseSharedStrings(archive.readText('xl/sharedStrings.xml'));
  const styles = parseStyles(archive.readText('xl/styles.xml'));
  return parseSheet(sheetXml, first.name, shared, styles);
}
