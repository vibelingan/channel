/** Stable, parser-independent worksheet contract used by catalog adapters. */

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
