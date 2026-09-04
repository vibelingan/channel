/** Stable spreadsheet facade: sniff, preflight every part, then decode. */
import type { Buffer } from 'node:buffer';
import type { SourceSheet } from './xlsx-contract.ts';
import { SpreadsheetFormatError } from './xlsx-preflight.ts';
import { readSheetJs } from './xlsx-sheetjs.ts';
import { ZipArchive, looksLikeZip } from './xlsx-zip.ts';

export type {
  SourceCell,
  SourceCellKind,
  SourceRow,
  SourceSheet,
} from './xlsx-contract.ts';
export {
  MAX_ATTRIBUTE_CHARS,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_TEXT_NODE_CHARS,
  MAX_XML_DEPTH,
  SpreadsheetFormatError,
  columnIndexFromReference,
  scanXml,
} from './xlsx-preflight.ts';

/** True when the bytes are a ZIP carrying the required OOXML spreadsheet parts. */
export function looksLikeSpreadsheet(bytes: Buffer): boolean {
  if (!looksLikeZip(bytes)) return false;
  try {
    const archive = new ZipArchive(bytes);
    return archive.has('xl/workbook.xml') && archive.has('[Content_Types].xml');
  } catch {
    return false;
  }
}

/** Read the first worksheet after the complete archive and OOXML preflight. */
export function readFirstSheet(bytes: Buffer): SourceSheet {
  if (!looksLikeZip(bytes)) {
    throw new SpreadsheetFormatError('file is not an OOXML spreadsheet');
  }
  return readSheetJs(bytes);
}
