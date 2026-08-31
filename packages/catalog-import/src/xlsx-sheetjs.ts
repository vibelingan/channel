import type { Buffer } from 'node:buffer';
import * as XLSX from 'xlsx';
import type { SourceCell, SourceRow, SourceSheet } from './xlsx-contract.ts';
import {
  SpreadsheetFormatError,
  type XlsxPreflightResult,
  preflightXlsx,
} from './xlsx-preflight.ts';

/** Private structural views keep SheetJS types out of the package contract. */
interface LibraryCell {
  t?: string;
  v?: unknown;
  w?: string;
  z?: string;
}

interface DenseLibrarySheet {
  '!data'?: (readonly (LibraryCell | undefined)[] | undefined)[];
}

function normalizeCell(
  cell: LibraryCell | undefined,
  numericLexeme: string | undefined,
): SourceCell | undefined {
  if (cell === undefined || cell.t === 'z') return undefined;

  switch (cell.t) {
    case 'n':
      return {
        text: numericLexeme ?? String(cell.v ?? ''),
        kind: 'number',
        dateFormatted: typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z),
      };
    case 'b':
      return {
        text: cell.v === true || cell.v === 1 ? 'TRUE' : 'FALSE',
        kind: 'boolean',
        dateFormatted: false,
      };
    case 'e':
      return {
        text: typeof cell.w === 'string' ? cell.w : String(cell.v ?? ''),
        kind: 'error',
        dateFormatted: false,
      };
    case 'd':
      return { text: String(cell.v ?? ''), kind: 'text', dateFormatted: true };
    default:
      return { text: String(cell.v ?? ''), kind: 'text', dateFormatted: false };
  }
}

function addressFor(rowNumber: number, columnIndex: number): string {
  let remaining = columnIndex + 1;
  let column = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    column = String.fromCharCode(65 + digit) + column;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return `${column}${rowNumber}`;
}

/** Decode with SheetJS CE 0.20.3 and normalize into the stable contract. */
export function readSheetJs(
  bytes: Buffer,
  completedPreflight?: XlsxPreflightResult,
): SourceSheet {
  const preflight = completedPreflight ?? preflightXlsx(bytes);
  try {
    const workbook = XLSX.read(bytes, {
      dense: true,
      cellDates: false,
      cellNF: true,
      cellText: true,
      bookVBA: true,
      bookFiles: true,
      WTF: true,
    });
    const firstSheetName = workbook.SheetNames[0];
    if (firstSheetName === undefined || firstSheetName !== preflight.selectedSheetName) {
      throw new SpreadsheetFormatError('SheetJS selected a different first worksheet');
    }
    const sheet = workbook.Sheets[firstSheetName] as DenseLibrarySheet | undefined;
    if (sheet === undefined) throw new SpreadsheetFormatError('selected worksheet is missing');
    const denseRows = sheet['!data'] ?? [];

    const rows: SourceRow[] = preflight.selectedRowNumbers.map((rowNumber) => {
      const libraryRow = denseRows[rowNumber - 1] ?? [];
      const cells = Array.from(
        { length: libraryRow.length },
        (_unused, columnIndex) =>
          normalizeCell(
            libraryRow[columnIndex],
            preflight.numericLexemesByAddress.get(addressFor(rowNumber, columnIndex)),
          ),
      );
      return { rowNumber, cells };
    });

    return { name: preflight.selectedSheetName, rows };
  } catch (error) {
    if (error instanceof SpreadsheetFormatError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SpreadsheetFormatError(`SheetJS could not parse workbook: ${message}`);
  }
}
