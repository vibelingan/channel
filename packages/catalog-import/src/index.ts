/**
 * Public surface of the provider-neutral catalog import package.
 *
 * Consumers (admin function, local CLI, admin UI) import from here. The
 * Dianxiaomi adapter is deliberately NOT re-exported from the root: a caller
 * that wants the Excel adapter asks for it by name via
 * `@vibelingan-channel/catalog-import/dianxiaomi`, which keeps the provider
 * boundary visible at every call site.
 */
export {
  CATALOG_IMPORT_SCHEMA_VERSION,
  type CandidateCategory,
  type CandidateMedia,
  type CatalogImportBundle,
  type CatalogProductCandidate,
  type CatalogProvider,
  type CatalogSourceAdapter,
  type CatalogVariantCandidate,
  type ImportFinding,
  type InventorySnapshot,
  type MatchHints,
  type Money,
  type SourceIdentity,
} from './contracts.ts';

export {
  FINDING_CODES,
  type FindingCode,
  type FindingLocation,
  STRUCTURAL_FINDING_CODES,
  errorFinding,
  hasErrors,
  isStructuralFinding,
  sortFindings,
  warningFinding,
} from './findings.ts';

export {
  type SourceKeyInput,
  candidateGroupKey,
  candidateSkuKey,
  normalizeIdentifier,
  normalizeStoreKey,
  sourceProductKey,
  sourceVariantKey,
} from './identity.ts';
export {
  type DescriptionResult,
  type SanitizeReport,
  normalizeDescription,
  sanitizeSourceHtml,
  sanitizeSourceHtmlWithReport,
  sourceHtmlToText,
} from './descriptions.ts';

export {
  type DateParseResult,
  type MoneyParseResult,
  OPEN_ENDED_DATE_SENTINEL,
  type QuantityParseResult,
  SOURCE_TIMEZONE_OFFSET_MINUTES,
  dedupeImageUrls,
  excelSerialToNaiveDateTime,
  parseSourceDate,
  parseSourceMoney,
  parseSourceQuantity,
  parseSourceUrl,
} from './values.ts';

export {
  MAX_COLUMNS,
  MAX_ROWS,
  SpreadsheetFormatError,
  looksLikeSpreadsheet,
  readFirstSheet,
} from './xlsx-sheet.ts';
export type {
  SourceCell,
  SourceCellKind,
  SourceRow,
  SourceSheet,
} from './xlsx-contract.ts';

export {
  type CatalogImportDetail,
  type GroupingCounts,
  type GroupingResult,
  type QuarantinedVariant,
  type SourceListing,
  type StoreListingRecord,
  type VariantInventory,
  countListings,
  groupListings,
} from './grouping.ts';

export {
  type InventoryResolution,
  displayQuantity,
  reconcileInventory,
} from './inventory.ts';

export {
  CATALOG_SOURCE_OBSERVATION_SCHEMA_VERSION,
  catalogSourceObservationSchema,
  catalogSourcePricingSchema,
  type CatalogObservationAdapter,
  type CatalogObservationBatch,
  type CatalogObservationFinding,
  type CatalogObservationWarning,
  type CatalogSourceObservation,
  type CatalogSourceObservationValidation,
  type CatalogSourcePricing,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from './source-observations.ts';
