/**
 * Stable finding codes.
 *
 * A finding is how the pipeline says "something is wrong with THIS row/item"
 * without throwing. Codes are part of the contract: the admin preview groups
 * on them, and a later connector reuses them rather than inventing its own
 * vocabulary, so they must stay provider-neutral and must not be renamed once
 * a job has been persisted with them.
 *
 * Severity is a policy statement, not a description:
 *   - `error`   the affected item cannot be published as-is
 *   - `warning` the item is usable; an operator should still look
 *
 * Structural codes (`WORKBOOK_*`) reject the whole file. Everything else
 * rejects at most one row or one item — a single malformed cell must never
 * cost the merchant the other 311 rows.
 */
import type { ImportFinding } from './contracts.ts';

export const FINDING_CODES = {
  // --- structural: the file cannot be interpreted at all -------------------
  WORKBOOK_NOT_XLSX: 'WORKBOOK_NOT_XLSX',
  WORKBOOK_UNREADABLE: 'WORKBOOK_UNREADABLE',
  WORKBOOK_NO_SHEET: 'WORKBOOK_NO_SHEET',
  WORKBOOK_NO_HEADER_ROW: 'WORKBOOK_NO_HEADER_ROW',
  WORKBOOK_MISSING_REQUIRED_HEADERS: 'WORKBOOK_MISSING_REQUIRED_HEADERS',
  WORKBOOK_DUPLICATE_HEADER: 'WORKBOOK_DUPLICATE_HEADER',
  WORKBOOK_NO_DATA_ROWS: 'WORKBOOK_NO_DATA_ROWS',

  // --- headers -------------------------------------------------------------
  HEADER_UNKNOWN: 'HEADER_UNKNOWN',

  // --- row identity --------------------------------------------------------
  ROW_MISSING_PARENT_SKU: 'ROW_MISSING_PARENT_SKU',
  ROW_MISSING_SKU: 'ROW_MISSING_SKU',
  ROW_MISSING_TITLE: 'ROW_MISSING_TITLE',
  ROW_MISSING_STORE: 'ROW_MISSING_STORE',
  ROW_DUPLICATE_STORE_VARIANT: 'ROW_DUPLICATE_STORE_VARIANT',

  // --- cell values ---------------------------------------------------------
  PRICE_INVALID: 'PRICE_INVALID',
  STOCK_INVALID: 'STOCK_INVALID',
  DATE_INVALID: 'DATE_INVALID',
  IMAGE_URL_INVALID: 'IMAGE_URL_INVALID',
  ATTRIBUTES_JSON_INVALID: 'ATTRIBUTES_JSON_INVALID',
  DESCRIPTION_PLACEHOLDER: 'DESCRIPTION_PLACEHOLDER',
  DESCRIPTION_HTML_SANITIZED: 'DESCRIPTION_HTML_SANITIZED',
  PROMOTION_DATE_OPEN_ENDED: 'PROMOTION_DATE_OPEN_ENDED',

  // --- grouping and reconciliation ----------------------------------------
  VARIANT_PARENT_CONFLICT: 'VARIANT_PARENT_CONFLICT',
  VARIANT_BRAND_CONFLICT: 'VARIANT_BRAND_CONFLICT',
  INVENTORY_CONFLICT: 'INVENTORY_CONFLICT',
  INVENTORY_UNKNOWN: 'INVENTORY_UNKNOWN',
} as const;

export type FindingCode = (typeof FINDING_CODES)[keyof typeof FINDING_CODES];

/** Structural codes reject the workbook; every other code rejects one item. */
export const STRUCTURAL_FINDING_CODES: readonly FindingCode[] = [
  FINDING_CODES.WORKBOOK_NOT_XLSX,
  FINDING_CODES.WORKBOOK_UNREADABLE,
  FINDING_CODES.WORKBOOK_NO_SHEET,
  FINDING_CODES.WORKBOOK_NO_HEADER_ROW,
  FINDING_CODES.WORKBOOK_MISSING_REQUIRED_HEADERS,
  FINDING_CODES.WORKBOOK_DUPLICATE_HEADER,
  FINDING_CODES.WORKBOOK_NO_DATA_ROWS,
] as const;

export function isStructuralFinding(finding: ImportFinding): boolean {
  return (STRUCTURAL_FINDING_CODES as readonly string[]).includes(finding.code);
}

/** Optional provenance attached to a finding; absent keys are never emitted. */
export interface FindingLocation {
  rowNumber?: number | undefined;
  parentSku?: string | undefined;
  sku?: string | undefined;
}

function withLocation(
  severity: ImportFinding['severity'],
  code: FindingCode,
  message: string,
  location: FindingLocation = {},
): ImportFinding {
  // Conditional spread rather than assigning `undefined`: the repo compiles
  // with exactOptionalPropertyTypes, and a persisted `{"sku": undefined}` also
  // round-trips through JSON as a missing key on one side and a present key on
  // the other, which breaks finding equality on repeat import.
  return {
    severity,
    code,
    message,
    ...(location.rowNumber === undefined ? {} : { rowNumber: location.rowNumber }),
    ...(location.parentSku === undefined ? {} : { parentSku: location.parentSku }),
    ...(location.sku === undefined ? {} : { sku: location.sku }),
  };
}

export function errorFinding(
  code: FindingCode,
  message: string,
  location?: FindingLocation,
): ImportFinding {
  return withLocation('error', code, message, location);
}

export function warningFinding(
  code: FindingCode,
  message: string,
  location?: FindingLocation,
): ImportFinding {
  return withLocation('warning', code, message, location);
}

export function hasErrors(findings: readonly ImportFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

/** Stable ordering for display and for byte-comparable repeat-import diffs. */
export function sortFindings(findings: readonly ImportFinding[]): ImportFinding[] {
  return [...findings].sort(
    (a, b) =>
      (a.rowNumber ?? 0) - (b.rowNumber ?? 0) ||
      a.code.localeCompare(b.code) ||
      (a.sku ?? '').localeCompare(b.sku ?? '') ||
      a.message.localeCompare(b.message),
  );
}
