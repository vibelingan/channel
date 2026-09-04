import type { Buffer } from 'node:buffer';
/**
 * The Dianxiaomi Excel adapter — the only provider-specific code in the
 * pipeline.
 *
 * Its whole job is to turn workbook bytes into provider-neutral values. Once
 * `parse` returns, nothing downstream knows or cares that the source was a
 * spreadsheet: a Lazada, Shopify or Alibaba adapter that produces the same
 * shapes reuses validation, matching, preview, publication, media, inventory
 * and storefront projection without changing a line.
 */
import { createHash } from 'node:crypto';
import {
  CATALOG_IMPORT_SCHEMA_VERSION,
  type CatalogImportBundle,
  type CatalogSourceAdapter,
} from '../../contracts.ts';
import { sortFindings } from '../../findings.ts';
import {
  type CatalogImportDetail,
  type SourceListing,
  countListings,
  groupListings,
} from '../../grouping.ts';
import { type DianxiaomiRow, detectDianxiaomiWorkbook, readDianxiaomiRows } from './workbook.ts';

export {
  type DianxiaomiReadResult,
  type DianxiaomiRow,
  SOURCE_CURRENCY,
  detectDianxiaomiWorkbook,
  readDianxiaomiRows,
} from './workbook.ts';

export {
  type DianxiaomiObservationInput,
  dianxiaomiObservationAdapter,
} from './observations.ts';

/** Marketplace channel these exports describe. */
export const DIANXIAOMI_TAXONOMY = 'lazada';

function listingFor(row: DianxiaomiRow): SourceListing {
  const capturedAt = row.sourceUpdatedAt?.iso ?? row.sourceCreatedAt?.iso;
  const hasCategory = row.categoryId !== undefined || row.categoryName !== undefined;
  return {
    rowNumber: row.rowNumber,
    provider: 'dianxiaomi',
    taxonomy: DIANXIAOMI_TAXONOMY,
    storeKey: row.store,
    parentSku: row.parentSku,
    sku: row.sku,
    title: row.title,
    attributes: row.attributes,
    optionValues: row.optionValues,
    productMedia: row.imageUrls,
    sourceListingStatus: row.sourceListingStatus,
    ...(row.brand === undefined ? {} : { brand: row.brand }),
    ...(row.description.html === undefined ? {} : { descriptionHtml: row.description.html }),
    ...(row.description.text === '' ? {} : { descriptionText: row.description.text }),
    descriptionSource: row.description.source,
    ...(hasCategory
      ? {
          category: {
            // Source taxonomy, kept verbatim. Mapping it onto a Channel
            // category is an operator decision, never an import-time guess.
            sourceTaxonomy: `dianxiaomi:${DIANXIAOMI_TAXONOMY}`,
            ...(row.categoryId === undefined ? {} : { sourceCategoryId: row.categoryId }),
            ...(row.categoryName === undefined ? {} : { sourceCategoryName: row.categoryName }),
          },
        }
      : {}),
    ...(row.variantImageUrl === undefined ? {} : { variantMedia: row.variantImageUrl }),
    ...(row.sourceRegularPrice === undefined ? {} : { sourceRegularPrice: row.sourceRegularPrice }),
    ...(row.sourcePromotionPrice === undefined
      ? {}
      : { sourcePromotionPrice: row.sourcePromotionPrice }),
    ...(row.stock === undefined ? {} : { quantity: row.stock }),
    ...(row.platformProductId === undefined ? {} : { externalProductId: row.platformProductId }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a workbook into a bundle plus everything the persistence and preview
 * layers need. `parse` below is the narrow contract method; this is the one
 * the import job actually calls.
 */
export function parseDianxiaomiWorkbook(bytes: Buffer): CatalogImportDetail {
  const sourceFileSha256 = sha256Hex(bytes);
  const read = readDianxiaomiRows(bytes);

  if (!read.ok) {
    return {
      bundle: {
        schemaVersion: CATALOG_IMPORT_SCHEMA_VERSION,
        provider: 'dianxiaomi',
        templateId: 'dianxiaomi:unknown',
        sourceFileSha256,
        products: [],
        findings: sortFindings(read.findings),
        ignoredHeaders: [],
      },
      storeListings: [],
      inventory: [],
      quarantined: [],
      counts: countListings([]),
      templateHeaders: read.headerLabels,
      sheetName: '',
      dataRowCount: 0,
      structurallyValid: false,
    };
  }

  const listings = read.rows.map(listingFor);
  const grouped = groupListings(listings);

  return {
    bundle: {
      schemaVersion: CATALOG_IMPORT_SCHEMA_VERSION,
      provider: 'dianxiaomi',
      templateId: read.templateId,
      sourceFileSha256,
      products: grouped.products,
      findings: sortFindings([...read.findings, ...grouped.findings]),
      ignoredHeaders: read.ignoredHeaders,
    },
    storeListings: grouped.storeListings,
    inventory: grouped.inventory,
    quarantined: grouped.quarantined,
    counts: countListings(listings),
    templateHeaders: read.headerLabels,
    sheetName: read.sheetName,
    dataRowCount: read.dataRowCount,
    structurallyValid: true,
  };
}

/** Workbook acquisition seam; normalization continues through the observation adapter above. */
export const dianxiaomiAdapter: CatalogSourceAdapter<Buffer> = {
  provider: 'dianxiaomi',
  detect(input: Buffer): Promise<boolean> {
    return Promise.resolve(detectDianxiaomiWorkbook(input));
  },
  parse(input: Buffer): Promise<CatalogImportBundle> {
    return Promise.resolve(parseDianxiaomiWorkbook(input).bundle);
  },
};
