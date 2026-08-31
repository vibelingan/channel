/**
 * Security and fidelity preflight for OOXML workbooks.
 *
 * SheetJS is intentionally downstream of this module. Every ZIP entry is
 * inflated and CRC-checked, every XML/relationship part is scanned with hard
 * limits, and every declared worksheet is shape-checked before SheetJS parses
 * any workbook data. Numeric `<v>` text is retained by cell address because a
 * JavaScript number cannot preserve the merchant's original decimal lexeme.
 */
import type { Buffer } from 'node:buffer';
import { ZipArchive, ZipFormatError } from './xlsx-zip.ts';

/** A worksheet larger than this is not a Dianxiaomi product export. */
export const MAX_ROWS = 200_000;
/** Excel permits more, but a product export uses tens of columns. */
export const MAX_COLUMNS = 2_048;
export const MAX_XML_DEPTH = 64;
export const MAX_TEXT_NODE_CHARS = 1_000_000;
export const MAX_ATTRIBUTE_CHARS = 8_192;

const REFUSED_PART_PREFIXES: readonly [string, string][] = [
  ['xl/vbaProject.bin', 'workbook contains macros'],
  ['xl/externalLinks/', 'workbook contains external links'],
  ['xl/activeX/', 'workbook contains ActiveX controls'],
  ['xl/embeddings/', 'workbook contains embedded objects'],
  ['customXml/', 'workbook contains custom XML parts'],
];

export class SpreadsheetFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetFormatError';
  }
}

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

function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

export function* scanXml(xml: string): Generator<XmlEvent> {
  let index = 0;
  let depth = 0;
  while (index < xml.length) {
    const next = xml.indexOf('<', index);
    if (next === -1) {
      const trailing = xml.slice(index);
      if (trailing.length > MAX_TEXT_NODE_CHARS) {
        throw new SpreadsheetFormatError('spreadsheet XML has an oversized text node');
      }
      if (trailing !== '') yield { type: 'text', text: decodeXmlEntities(trailing) };
      return;
    }
    if (next > index) {
      if (next - index > MAX_TEXT_NODE_CHARS) {
        throw new SpreadsheetFormatError('spreadsheet XML has an oversized text node');
      }
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
      depth = Math.max(0, depth - 1);
      yield { type: 'close', name };
      continue;
    }

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
      if (valueEnd - valueStart > MAX_ATTRIBUTE_CHARS) {
        throw new SpreadsheetFormatError('spreadsheet XML has an oversized attribute value');
      }
      attrs.set(attrName, decodeXmlEntities(xml.slice(valueStart, valueEnd)));
      cursor = valueEnd + 1;
    }

    index = cursor;
    if (!selfClosing) {
      depth += 1;
      if (depth > MAX_XML_DEPTH) {
        throw new SpreadsheetFormatError(
          `spreadsheet XML nests deeper than ${MAX_XML_DEPTH} levels`,
        );
      }
    }
    yield { type: 'open', name, attrs, selfClosing };
  }
}

interface SheetRef {
  name: string;
  relationshipId: string;
}

function assertNot1904(xml: string): void {
  for (const event of scanXml(xml)) {
    if (event.type === 'open' && event.name === 'workbookpr') {
      const flag = event.attrs.get('date1904');
      if (flag === '1' || flag === 'true') {
        throw new SpreadsheetFormatError(
          'workbook uses the 1904 date system, which this reader does not support',
        );
      }
    }
  }
}

function assertNoExternalReferences(workbookXml: string): void {
  for (const event of scanXml(workbookXml)) {
    if (
      event.type === 'open' &&
      (event.name === 'externalreference' || event.name === 'externalreferences')
    ) {
      throw new SpreadsheetFormatError('workbook declares external references');
    }
  }
}

function parseWorkbookSheets(xml: string): SheetRef[] {
  const sheets: SheetRef[] = [];
  for (const event of scanXml(xml)) {
    if (event.type === 'open' && event.name === 'sheet') {
      sheets.push({
        name: event.attrs.get('name') ?? '',
        relationshipId: event.attrs.get('r:id') ?? event.attrs.get('id') ?? '',
      });
    }
  }
  return sheets;
}

function parseRelationships(xml: string | null): Map<string, string> {
  const relationships = new Map<string, string>();
  if (xml === null) return relationships;
  for (const event of scanXml(xml)) {
    if (event.type !== 'open' || event.name !== 'relationship') continue;
    const id = event.attrs.get('id');
    const target = event.attrs.get('target');
    if (id === undefined || target === undefined) continue;
    if (relationships.has(id)) {
      throw new SpreadsheetFormatError(`relationship id ${id} is declared more than once`);
    }
    relationships.set(id, target);
  }
  return relationships;
}

function assertNoRefusedParts(names: readonly string[]): void {
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const [prefix, reason] of REFUSED_PART_PREFIXES) {
      const lowerPrefix = prefix.toLowerCase();
      if (lower === lowerPrefix || lower.startsWith(lowerPrefix)) {
        throw new SpreadsheetFormatError(`${reason} (${name})`);
      }
    }
  }
}

function resolvePartPath(target: string): string | null {
  if (target === '' || target.includes('\u0000')) return null;
  const trimmed = target.startsWith('/') ? target.slice(1) : target;
  if (trimmed.split('/').includes('..')) return null;
  return trimmed.startsWith('xl/') ? trimmed : `xl/${trimmed}`;
}

/** `B` -> 1, `AA` -> 26. Returns -1 for a non-column reference. */
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

function columnName(index: number): string {
  let remaining = index + 1;
  let name = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

interface WorksheetShape {
  rowNumbers: number[];
  numericLexemes: Map<string, string>;
}

function inspectWorksheet(xml: string, retainLexemes: boolean): WorksheetShape {
  const rowNumbers: number[] = [];
  const numericLexemes = new Map<string, string>();
  const seenRows = new Set<number>();
  let currentRow = 0;
  let previousRow = 0;
  let columnIndex = -1;
  let cellType = '';
  let address = '';
  let value = '';
  let collectingValue = false;
  let inCell = false;

  const recordRow = (rowNumber: number): void => {
    if (seenRows.has(rowNumber)) {
      throw new SpreadsheetFormatError(`worksheet declares row ${rowNumber} more than once`);
    }
    if (rowNumbers.length >= MAX_ROWS || rowNumber > MAX_ROWS) {
      throw new SpreadsheetFormatError(`worksheet exceeds the ${MAX_ROWS}-row limit`);
    }
    seenRows.add(rowNumber);
    rowNumbers.push(rowNumber);
  };

  for (const event of scanXml(xml)) {
    if (event.type === 'open') {
      if (event.name === 'dimension') {
        const ref = event.attrs.get('ref') ?? '';
        const end = ref.includes(':') ? (ref.split(':')[1] ?? '') : ref;
        const column = columnIndexFromReference(end);
        const row = Number.parseInt(end.replace(/^[A-Za-z]+/, ''), 10);
        if (column >= MAX_COLUMNS) {
          throw new SpreadsheetFormatError(
            `worksheet declares ${column + 1} columns, over the ${MAX_COLUMNS} limit`,
          );
        }
        if (Number.isFinite(row) && row > MAX_ROWS) {
          throw new SpreadsheetFormatError(
            `worksheet declares ${row} rows, over the ${MAX_ROWS} limit`,
          );
        }
      } else if (event.name === 'row') {
        const rawRow = event.attrs.get('r');
        const declared = rawRow === undefined ? previousRow + 1 : Number(rawRow);
        if (!Number.isInteger(declared) || declared <= 0) {
          throw new SpreadsheetFormatError('worksheet contains an invalid row number');
        }
        currentRow = declared;
        previousRow = declared;
        columnIndex = -1;
        recordRow(declared);
        if (event.selfClosing) currentRow = 0;
      } else if (event.name === 'c') {
        if (currentRow <= 0) {
          throw new SpreadsheetFormatError('worksheet cell is outside a row');
        }
        const reference = event.attrs.get('r') ?? '';
        const referencedColumn = columnIndexFromReference(reference);
        columnIndex = referencedColumn >= 0 ? referencedColumn : columnIndex + 1;
        if (columnIndex >= MAX_COLUMNS) {
          throw new SpreadsheetFormatError(`worksheet exceeds the ${MAX_COLUMNS}-column limit`);
        }
        const referencedRow = Number.parseInt(reference.replace(/^[A-Za-z]+/, ''), 10);
        if (Number.isFinite(referencedRow) && referencedRow !== currentRow) {
          throw new SpreadsheetFormatError(
            `worksheet cell ${reference} does not belong to row ${currentRow}`,
          );
        }
        cellType = event.attrs.get('t') ?? 'n';
        address = `${columnName(columnIndex)}${currentRow}`;
        value = '';
        inCell = true;
        collectingValue = false;
        if (event.selfClosing) inCell = false;
      } else if (event.name === 'v' && inCell) {
        collectingValue = !event.selfClosing;
      }
      continue;
    }

    if (event.type === 'text') {
      if (collectingValue) value += event.text;
      continue;
    }

    if (event.name === 'v') collectingValue = false;
    else if (event.name === 'c') {
      if (retainLexemes && (cellType === '' || cellType === 'n') && value !== '') {
        numericLexemes.set(address, value);
      }
      inCell = false;
      collectingValue = false;
    } else if (event.name === 'row') {
      currentRow = 0;
    }
  }

  return { rowNumbers, numericLexemes };
}

function isXmlPart(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.rels');
}

export interface XlsxPreflightResult {
  selectedSheetName: string;
  selectedRowNumbers: readonly number[];
  numericLexemesByAddress: ReadonlyMap<string, string>;
}

/** Run the complete archive and OOXML preflight required before SheetJS. */
export function preflightXlsx(bytes: Buffer): XlsxPreflightResult {
  try {
    const archive = new ZipArchive(bytes);
    assertNoRefusedParts(archive.names());

    archive.verifyAllEntries((name, part) => {
      if (isXmlPart(name)) {
        for (const _event of scanXml(part.toString('utf8'))) {
          // Exhaust the generator: limits and DTD refusal are the validation.
        }
      }
    });

    if (!archive.has('[Content_Types].xml')) {
      throw new SpreadsheetFormatError('workbook content-types part is missing');
    }
    const workbookXml = archive.readText('xl/workbook.xml');
    if (workbookXml === null) throw new SpreadsheetFormatError('workbook part is missing');

    assertNot1904(workbookXml);
    assertNoExternalReferences(workbookXml);
    const sheets = parseWorkbookSheets(workbookXml);
    const first = sheets[0];
    if (first === undefined) throw new SpreadsheetFormatError('workbook declares no worksheets');

    const relationships = parseRelationships(archive.readText('xl/_rels/workbook.xml.rels'));
    let selectedShape: WorksheetShape | undefined;
    for (let index = 0; index < sheets.length; index += 1) {
      const sheet = sheets[index] as SheetRef;
      const target = relationships.get(sheet.relationshipId);
      if (target === undefined) {
        throw new SpreadsheetFormatError(
          `worksheet relationship ${sheet.relationshipId} does not resolve`,
        );
      }
      const path = resolvePartPath(target);
      if (path === null) {
        throw new SpreadsheetFormatError('worksheet relationship target is not a package part');
      }
      const sheetXml = archive.readText(path);
      if (sheetXml === null) {
        throw new SpreadsheetFormatError(`worksheet part ${path} is missing`);
      }
      const shape = inspectWorksheet(sheetXml, index === 0);
      if (index === 0) selectedShape = shape;
    }

    if (selectedShape === undefined) {
      throw new SpreadsheetFormatError('selected worksheet could not be preflighted');
    }
    return {
      selectedSheetName: first.name,
      selectedRowNumbers: selectedShape.rowNumbers,
      numericLexemesByAddress: selectedShape.numericLexemes,
    };
  } catch (error) {
    if (error instanceof ZipFormatError) throw new SpreadsheetFormatError(error.message);
    throw error;
  }
}
