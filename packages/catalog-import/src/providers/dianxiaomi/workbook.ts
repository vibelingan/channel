/**
 * Dianxiaomi workbook reading: worksheet rows in, typed source records out.
 *
 * One workbook row is one STORE-SCOPED SKU VARIANT — not a product. Grouping
 * those rows into products and variants happens later (`grouping.ts`); this
 * file's only job is to turn cells into values that are either correct or
 * explicitly rejected.
 *
 * The rule that shapes everything here: a bad cell costs its own row, and
 * nothing more. Only a workbook that cannot be identified at all — no parent
 * SKU column, no SKU column, no title, no store — is rejected whole. A
 * merchant with three malformed rows out of 312 gets 309 products and three
 * findings, not a failed import.
 */
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ImportFinding, Money } from '../../contracts.ts';
import {
  type DescriptionSource,
  type ResolvedDescription,
  resolveDescription,
} from '../../description-fallback.ts';
import { FINDING_CODES, errorFinding, warningFinding } from '../../findings.ts';
import {
  dedupeImageUrls,
  excelSerialToNaiveDateTime,
  parseSourceDate,
  parseSourceMoney,
  parseSourceQuantity,
  parseSourceUrl,
} from '../../values.ts';
import {
  type SourceCell,
  type SourceRow,
  SpreadsheetFormatError,
  looksLikeSpreadsheet,
  readFirstSheet,
} from '../../xlsx-sheet.ts';
import { type DianxiaomiField, type HeaderMapping, mapHeaders } from './headers.ts';

/**
 * Source prices in this template are CNY, and the `_MY` suffix on the store
 * names is a STORE name, not a currency. Reading it as Malaysian ringgit would
 * put a number roughly 1.5x too small on the storefront while looking correct.
 */
export const SOURCE_CURRENCY = 'CNY';

/** Exports occasionally carry a title banner above the real header row. */
const MAX_HEADER_SCAN_ROWS = 10;

/**
 * Gallery ceiling per row (APPROVED_DESIGN_SPEC §12.2). Mirrors the catalog's
 * own `PRODUCT_IMAGE_MAX_COUNT`. Kept as a local constant so this package stays
 * dependency-free; the publish path enforces the catalog's value again.
 */
export const MAX_PRODUCT_GALLERY_IMAGES = 9;

export interface SourceDateValue {
  /** Instant derived by reading the cell as UTC+8. */
  iso: string;
  /** The cell exactly as the workbook spelled it. */
  source: string;
  /** The cell is the far-future sentinel, i.e. "no end date". */
  openEnded: boolean;
}

export interface DianxiaomiRow {
  rowNumber: number;
  /** Trimmed original text — the canonical form is derived, never stored here. */
  parentSku: string;
  sku: string;
  title: string;
  store: string;
  brand?: string;
  /** Resolved through the fallback chain; carries which rung supplied it. */
  description: ResolvedDescription;
  shortDescription?: string;
  /** Human-readable variant label, when the source supplies one. */
  variantName?: string;
  categoryId?: string;
  categoryName?: string;
  /** The marketplace's own product id; absent means a draft/global record. */
  platformProductId?: string;
  sourceRegularPrice?: Money;
  sourcePromotionPrice?: Money;
  promotionStart?: SourceDateValue;
  promotionEnd?: SourceDateValue;
  stock?: number;
  attributes: Record<string, string | number | boolean>;
  optionValues: Record<string, string>;
  imageUrls: string[];
  variantImageUrl?: string;
  sourceListingStatus: 'published' | 'draft' | 'unknown';
  sourceCreatedAt?: SourceDateValue;
  sourceUpdatedAt?: SourceDateValue;
  /** When the marketplace listed the product; pairs with platformProductId. */
  platformListedAt?: SourceDateValue;
}

export type DianxiaomiReadResult =
  | {
      ok: true;
      templateId: string;
      sheetName: string;
      headerRowNumber: number;
      rows: DianxiaomiRow[];
      /** Rows the workbook contained, including the ones that were rejected. */
      dataRowCount: number;
      findings: ImportFinding[];
      ignoredHeaders: string[];
      /** Columns the table recognises but deliberately does not import. */
      recognisedUnusedHeaders: string[];
      headerLabels: string[];
    }
  | { ok: false; findings: ImportFinding[]; headerLabels: string[] };

function cellText(cell: SourceCell | undefined): string {
  if (cell === undefined) return '';
  if (cell.kind === 'error') return '';
  return cell.text;
}

/**
 * Read a cell that is expected to hold a timestamp. A date-formatted numeric
 * cell holds an Excel serial, which is meaningless as text; everything else is
 * taken at face value so a merchant who typed `2026-08-26` still works.
 */
function cellDateText(cell: SourceCell | undefined): string {
  if (cell === undefined) return '';
  if (cell.kind === 'number' && cell.dateFormatted) {
    return excelSerialToNaiveDateTime(Number(cell.text)) ?? '';
  }
  return cell.text;
}

function textAt(row: SourceRow, mapping: HeaderMapping, field: DianxiaomiField): string {
  const column = mapping.columns.get(field);
  return column === undefined ? '' : cellText(row.cells[column]).trim();
}

function rawAt(row: SourceRow, mapping: HeaderMapping, field: DianxiaomiField): string {
  const column = mapping.columns.get(field);
  return column === undefined ? '' : cellText(row.cells[column]);
}

function dateTextAt(row: SourceRow, mapping: HeaderMapping, field: DianxiaomiField): string {
  const column = mapping.columns.get(field);
  return column === undefined ? '' : cellDateText(row.cells[column]).trim();
}

/** Keys that must never be copied out of source data into an object. */
const FORBIDDEN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Parse the attributes cell. Malformed JSON is an item finding, never a thrown
 * error: one merchant's broken attribute blob must not end the import.
 */
function parseAttributes(
  raw: string,
  location: { rowNumber: number; parentSku?: string; sku?: string },
  findings: ImportFinding[],
): Record<string, string | number | boolean> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    findings.push(
      warningFinding(
        FINDING_CODES.ATTRIBUTES_JSON_INVALID,
        'Attributes cell is not valid JSON; attributes were dropped for this row.',
        location,
      ),
    );
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    findings.push(
      warningFinding(
        FINDING_CODES.ATTRIBUTES_JSON_INVALID,
        'Attributes cell is valid JSON but not an object; attributes were dropped for this row.',
        location,
      ),
    );
    return {};
  }

  const entries: [string, string | number | boolean][] = [];
  for (const [key, value] of Object.entries(parsed)) {
    const name = key.trim();
    if (name === '' || FORBIDDEN_ATTRIBUTE_KEYS.has(name)) continue;
    if (typeof value === 'string' || typeof value === 'boolean') {
      entries.push([name, value]);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      entries.push([name, value]);
    }
    // Nested objects and arrays are dropped silently: they carry no meaning
    // the Channel catalog can render, and flattening them would invent one.
  }
  // fromEntries defines own properties, so a hostile key cannot walk the
  // prototype chain even before the filter above.
  return Object.fromEntries(entries);
}

function readMoney(
  raw: string,
  field: 'regular' | 'promotion',
  location: { rowNumber: number; parentSku?: string; sku?: string },
  findings: ImportFinding[],
): Money | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = parseSourceMoney(raw);
  if (!parsed.ok) {
    findings.push(
      warningFinding(
        FINDING_CODES.PRICE_INVALID,
        `${field === 'regular' ? 'Regular' : 'Promotion'} price ${JSON.stringify(raw)} is not a usable amount; it was left unset.`,
        location,
      ),
    );
    return undefined;
  }
  if (parsed.rounded) {
    findings.push(
      warningFinding(
        FINDING_CODES.PRICE_INVALID,
        `${field === 'regular' ? 'Regular' : 'Promotion'} price ${JSON.stringify(raw)} carried more precision than cents and was rounded.`,
        location,
      ),
    );
  }
  return { amountMinor: parsed.amountMinor, currency: SOURCE_CURRENCY };
}

function readDate(
  raw: string,
  label: string,
  location: { rowNumber: number; parentSku?: string; sku?: string },
  findings: ImportFinding[],
): SourceDateValue | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = parseSourceDate(raw);
  if (!parsed.ok) {
    findings.push(
      warningFinding(
        FINDING_CODES.DATE_INVALID,
        `${label} ${JSON.stringify(raw)} is not a usable date; it was left unset.`,
        location,
      ),
    );
    return undefined;
  }
  if (parsed.openEnded) {
    findings.push(
      warningFinding(
        FINDING_CODES.PROMOTION_DATE_OPEN_ENDED,
        `${label} is the open-ended source sentinel; it must not be shown as a real date.`,
        location,
      ),
    );
  }
  return { iso: parsed.iso, source: parsed.source, openEnded: parsed.openEnded };
}

function readImageUrls(
  row: SourceRow,
  mapping: HeaderMapping,
  location: { rowNumber: number; parentSku?: string; sku?: string },
  findings: ImportFinding[],
): string[] {
  const columns = mapping.multiColumns.get('imageUrls') ?? [];
  const raw: string[] = [];
  for (const column of columns) {
    const value = cellText(row.cells[column]).trim();
    if (value === '') continue;
    // One cell may hold several URLs; Dianxiaomi separates them with commas,
    // semicolons or newlines depending on the template revision.
    for (const part of value.split(/[\s,;|]+/u)) {
      if (part === '') continue;
      if (parseSourceUrl(part) === null) {
        findings.push(
          warningFinding(
            FINDING_CODES.IMAGE_URL_INVALID,
            `Image address ${JSON.stringify(part)} is not a usable http(s) URL; it was skipped.`,
            location,
          ),
        );
        continue;
      }
      raw.push(part);
    }
  }
  const deduped = dedupeImageUrls(raw);
  if (deduped.length > MAX_PRODUCT_GALLERY_IMAGES) {
    findings.push(
      warningFinding(
        FINDING_CODES.GALLERY_TRUNCATED,
        `Row lists ${deduped.length} images; the catalog shows at most ${MAX_PRODUCT_GALLERY_IMAGES}, so the extras were dropped.`,
        location,
      ),
    );
  }
  return deduped.slice(0, MAX_PRODUCT_GALLERY_IMAGES);
}

const PUBLISHED_STATUS_WORDS: ReadonlySet<string> = new Set([
  '在售',
  '上架',
  '已上架',
  '销售中',
  'active',
  'live',
  'published',
  'online',
]);
const DRAFT_STATUS_WORDS: ReadonlySet<string> = new Set([
  '草稿',
  '未上架',
  '下架',
  '待发布',
  'draft',
  'inactive',
  'pending',
  'offline',
  'unpublished',
]);

/**
 * Source listing status.
 *
 * An explicit status column wins. Otherwise the marketplace product id decides:
 * a row without one has never been listed, which the merchant confirmed still
 * makes it eligible for the Channel website. Note that this is the SOURCE's
 * status — Channel publication is a separate, operator-owned decision.
 */
function readListingStatus(
  statusText: string,
  platformProductId: string,
): DianxiaomiRow['sourceListingStatus'] {
  const normalized = statusText.trim().toLowerCase();
  if (normalized !== '') {
    if (PUBLISHED_STATUS_WORDS.has(normalized)) return 'published';
    if (DRAFT_STATUS_WORDS.has(normalized)) return 'draft';
  }
  if (platformProductId !== '') return 'published';
  return 'draft';
}

/** Which finding, if any, records the rung the description came from. */
const DESCRIPTION_FALLBACK_FINDINGS: Partial<
  Record<
    DescriptionSource,
    { code: (typeof FINDING_CODES)[keyof typeof FINDING_CODES]; message: string }
  >
> = {
  shortDescription: {
    code: FINDING_CODES.DESCRIPTION_FALLBACK_SHORT,
    message: 'Description was taken from the short-description column.',
  },
  structured: {
    code: FINDING_CODES.DESCRIPTION_FALLBACK_STRUCTURED,
    message:
      'Description was assembled from the title, brand and supplied attributes. It restates source fields only.',
  },
  titleAndSpecs: {
    code: FINDING_CODES.DESCRIPTION_FALLBACK_TITLE_ONLY,
    message:
      'Description was assembled from the title and specification columns only. An operator should review it before publication.',
  },
  none: {
    code: FINDING_CODES.DESCRIPTION_MISSING,
    message: 'No description could be derived from any source field.',
  },
};

/** Physical specifications, used by the last rung of the fallback chain. */
function readSpecs(row: SourceRow, mapping: HeaderMapping): Record<string, string> {
  const pairs: [string, string][] = [];
  const specFields: [DianxiaomiField, string][] = [
    ['weightKg', 'Weight (kg)'],
    ['lengthCm', 'Length (cm)'],
    ['widthCm', 'Width (cm)'],
    ['heightCm', 'Height (cm)'],
  ];
  for (const [field, label] of specFields) {
    const value = textAt(row, mapping, field);
    if (value !== '') pairs.push([label, value]);
  }
  return Object.fromEntries(pairs);
}

function readOptionValues(row: SourceRow, mapping: HeaderMapping): Record<string, string> {
  const pairs: [string, string][] = [];
  const slots: [DianxiaomiField, DianxiaomiField][] = [
    ['optionName1', 'optionValue1'],
    ['optionName2', 'optionValue2'],
  ];
  slots.forEach(([nameField, valueField], slot) => {
    const name = textAt(row, mapping, nameField);
    const value = textAt(row, mapping, valueField);
    if (value === '') return;
    // An unnamed option still needs a stable key, or two variants that differ
    // only by an unnamed option would look identical.
    const key = name === '' ? `option${slot + 1}` : name;
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) return;
    pairs.push([key, value]);
  });
  return Object.fromEntries(pairs);
}

/**
 * Locate the header row. Scanning a few rows rather than assuming row 1 is
 * what lets a template with a title banner still import; requiring ALL the
 * identity columns is what stops a data row full of text being mistaken for
 * a header.
 */
function findHeaderRow(
  rows: readonly SourceRow[],
): { row: SourceRow; mapping: HeaderMapping } | null {
  let best: { row: SourceRow; mapping: HeaderMapping } | null = null;
  for (const row of rows.slice(0, MAX_HEADER_SCAN_ROWS)) {
    const mapping = mapHeaders(row.cells.map((cell) => cellText(cell)));
    if (mapping.missingRequired.length === 0) return { row, mapping };
    if (best === null || mapping.columns.size > best.mapping.columns.size) best = { row, mapping };
  }
  return best;
}

/**
 * Template fingerprint: the provider/channel plus a digest of the recognised
 * header names. Two exports of the same template revision agree; a revision
 * that adds or renames a column produces a different id, so a preview can say
 * which template a job was read with.
 */
function templateIdFor(mapping: HeaderMapping): string {
  const recognised = [...mapping.columns.keys(), ...mapping.multiColumns.keys()].sort().join('|');
  const digest = createHash('sha256').update(recognised).digest('hex').slice(0, 12);
  return `dianxiaomi:lazada-global:${digest}`;
}

/** Parse an already-loaded worksheet. Split out so tests need no ZIP. */
export function readDianxiaomiRows(bytes: Buffer): DianxiaomiReadResult {
  let sheet: ReturnType<typeof readFirstSheet>;
  try {
    sheet = readFirstSheet(bytes);
  } catch (error) {
    const message = error instanceof SpreadsheetFormatError ? error.message : 'unreadable workbook';
    return {
      ok: false,
      headerLabels: [],
      findings: [
        errorFinding(FINDING_CODES.WORKBOOK_UNREADABLE, `Workbook could not be read: ${message}`),
      ],
    };
  }

  const header = findHeaderRow(sheet.rows);
  if (header === null) {
    return {
      ok: false,
      headerLabels: [],
      findings: [
        errorFinding(FINDING_CODES.WORKBOOK_NO_HEADER_ROW, 'Worksheet contains no rows at all.'),
      ],
    };
  }

  const { mapping } = header;
  const headerLabels = mapping.presentHeaders;

  if (mapping.missingRequired.length > 0) {
    return {
      ok: false,
      headerLabels,
      findings: [
        errorFinding(
          FINDING_CODES.WORKBOOK_MISSING_REQUIRED_HEADERS,
          `Workbook is missing required columns: ${mapping.missingRequired.join(', ')}. Columns found: ${
            headerLabels.length > 0 ? headerLabels.join(', ') : '(none)'
          }.`,
          { rowNumber: header.row.rowNumber },
        ),
      ],
    };
  }
  if (mapping.duplicates.length > 0) {
    return {
      ok: false,
      headerLabels,
      findings: mapping.duplicates.map((duplicate) =>
        errorFinding(
          FINDING_CODES.WORKBOOK_DUPLICATE_HEADER,
          `Two columns both map to ${duplicate.field} (${duplicate.labels.join(', ')}); which one is authoritative cannot be guessed.`,
          { rowNumber: header.row.rowNumber },
        ),
      ),
    };
  }

  const findings: ImportFinding[] = [];
  // Recognised-but-unused columns are NOT reported as findings: they are an
  // expected, understood part of this template, and reporting 7 of them on
  // every job would bury the findings that need action.
  for (const unknown of mapping.unknown) {
    findings.push(
      warningFinding(
        FINDING_CODES.HEADER_UNKNOWN,
        `Column ${JSON.stringify(unknown.label)} is not recognised and was ignored.`,
        { rowNumber: header.row.rowNumber },
      ),
    );
  }

  const dataRows = sheet.rows.filter((row) => row.rowNumber > header.row.rowNumber);
  if (dataRows.length === 0) {
    return {
      ok: false,
      headerLabels,
      findings: [
        ...findings,
        errorFinding(
          FINDING_CODES.WORKBOOK_NO_DATA_ROWS,
          'Workbook has a header row but no data rows.',
        ),
      ],
    };
  }

  const rows: DianxiaomiRow[] = [];
  let dataRowCount = 0;

  for (const row of dataRows) {
    const parentSku = textAt(row, mapping, 'parentSku');
    const sku = textAt(row, mapping, 'sku');
    const title = textAt(row, mapping, 'title');
    const store = textAt(row, mapping, 'store');

    // A row with nothing in any identity column is trailing spreadsheet
    // padding, not a record. It is skipped without a finding; an empty row
    // reported 40 times would bury the findings that matter.
    if (parentSku === '' && sku === '' && title === '' && store === '') continue;
    dataRowCount += 1;

    const location = {
      rowNumber: row.rowNumber,
      ...(parentSku === '' ? {} : { parentSku }),
      ...(sku === '' ? {} : { sku }),
    };

    const missing: string[] = [];
    if (parentSku === '') missing.push('parent SKU');
    if (sku === '') missing.push('SKU');
    if (title === '') missing.push('title');
    if (store === '') missing.push('store');
    if (missing.length > 0) {
      const code =
        parentSku === ''
          ? FINDING_CODES.ROW_MISSING_PARENT_SKU
          : sku === ''
            ? FINDING_CODES.ROW_MISSING_SKU
            : title === ''
              ? FINDING_CODES.ROW_MISSING_TITLE
              : FINDING_CODES.ROW_MISSING_STORE;
      findings.push(
        errorFinding(
          code,
          `Row is missing ${missing.join(', ')}; it cannot be identified.`,
          location,
        ),
      );
      continue;
    }

    const rawDescription = rawAt(row, mapping, 'description');
    const rawShortDescription = rawAt(row, mapping, 'shortDescription');
    const rowAttributes = parseAttributes(rawAt(row, mapping, 'attributes'), location, findings);
    const rowOptionValues = readOptionValues(row, mapping);
    const description = resolveDescription({
      description: rawDescription,
      shortDescription: rawShortDescription,
      title,
      brand: textAt(row, mapping, 'brand') || undefined,
      attributes: rowAttributes,
      optionValues: rowOptionValues,
      specs: readSpecs(row, mapping),
    });

    if (description.source !== 'description' && rawDescription.trim() !== '') {
      findings.push(
        warningFinding(
          FINDING_CODES.DESCRIPTION_PLACEHOLDER,
          'Description contains only placeholder markup; it was treated as absent.',
          location,
        ),
      );
    }
    if (description.sanitized) {
      findings.push(
        warningFinding(
          FINDING_CODES.DESCRIPTION_HTML_SANITIZED,
          'Description contained markup that was removed before storage.',
          location,
        ),
      );
    }
    const fallbackFinding = DESCRIPTION_FALLBACK_FINDINGS[description.source];
    if (fallbackFinding !== undefined) {
      findings.push(warningFinding(fallbackFinding.code, fallbackFinding.message, location));
    }

    let stock: number | undefined;
    const stockText = textAt(row, mapping, 'stock');
    if (stockText !== '') {
      const parsed = parseSourceQuantity(stockText);
      if (parsed.ok) {
        stock = parsed.quantity;
      } else {
        findings.push(
          warningFinding(
            FINDING_CODES.STOCK_INVALID,
            `Stock ${JSON.stringify(stockText)} is not a whole non-negative number; inventory is unknown for this listing.`,
            location,
          ),
        );
      }
    }

    const brand = textAt(row, mapping, 'brand');
    const shortDescription = textAt(row, mapping, 'shortDescription');
    const categoryId = textAt(row, mapping, 'categoryId');
    const categoryName = textAt(row, mapping, 'categoryName');
    const platformProductId = textAt(row, mapping, 'platformProductId');
    const variantImageUrl = textAt(row, mapping, 'variantImageUrl');
    const variantName = textAt(row, mapping, 'variantName');
    const regularPrice = readMoney(
      rawAt(row, mapping, 'regularPrice'),
      'regular',
      location,
      findings,
    );
    const promotionPrice = readMoney(
      rawAt(row, mapping, 'promotionPrice'),
      'promotion',
      location,
      findings,
    );

    rows.push({
      rowNumber: row.rowNumber,
      parentSku,
      sku,
      title,
      store,
      description,
      attributes: rowAttributes,
      optionValues: rowOptionValues,
      imageUrls: readImageUrls(row, mapping, location, findings),
      sourceListingStatus: readListingStatus(
        textAt(row, mapping, 'sourceStatus'),
        platformProductId,
      ),
      ...(brand === '' ? {} : { brand }),
      ...(shortDescription === '' ? {} : { shortDescription }),
      ...(categoryId === '' ? {} : { categoryId }),
      ...(categoryName === '' ? {} : { categoryName }),
      ...(platformProductId === '' ? {} : { platformProductId }),
      ...(variantImageUrl === '' || parseSourceUrl(variantImageUrl) === null
        ? {}
        : { variantImageUrl }),
      ...(regularPrice === undefined ? {} : { sourceRegularPrice: regularPrice }),
      ...(promotionPrice === undefined ? {} : { sourcePromotionPrice: promotionPrice }),
      ...(stock === undefined ? {} : { stock }),
      ...withDate(
        'promotionStart',
        dateTextAt(row, mapping, 'promotionStart'),
        'Promotion start',
        location,
        findings,
      ),
      ...withDate(
        'promotionEnd',
        dateTextAt(row, mapping, 'promotionEnd'),
        'Promotion end',
        location,
        findings,
      ),
      ...withDate(
        'sourceCreatedAt',
        dateTextAt(row, mapping, 'sourceCreatedAt'),
        'Created at',
        location,
        findings,
      ),
      ...withDate(
        'sourceUpdatedAt',
        dateTextAt(row, mapping, 'sourceUpdatedAt'),
        'Updated at',
        location,
        findings,
      ),
      ...withDate(
        'platformListedAt',
        dateTextAt(row, mapping, 'platformListedAt'),
        'Platform listed at',
        location,
        findings,
      ),
      ...(variantName === '' ? {} : { variantName }),
    });
  }

  return {
    ok: true,
    templateId: templateIdFor(mapping),
    sheetName: sheet.name,
    headerRowNumber: header.row.rowNumber,
    rows,
    dataRowCount,
    findings,
    ignoredHeaders: mapping.unknown.map((entry) => entry.label),
    recognisedUnusedHeaders: mapping.recognisedUnused.map((entry) => entry.label),
    headerLabels,
  };
}

function withDate<K extends string>(
  key: K,
  raw: string,
  label: string,
  location: { rowNumber: number; parentSku?: string; sku?: string },
  findings: ImportFinding[],
): Record<K, SourceDateValue> | Record<string, never> {
  const value = readDate(raw, label, location, findings);
  return value === undefined ? {} : ({ [key]: value } as Record<K, SourceDateValue>);
}

/** True when the bytes are an `.xlsx` this adapter is willing to open. */
export function detectDianxiaomiWorkbook(bytes: Buffer): boolean {
  return looksLikeSpreadsheet(bytes);
}
