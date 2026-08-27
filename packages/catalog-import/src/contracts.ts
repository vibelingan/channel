/**
 * Provider-neutral catalog import contract.
 *
 * This file is normative (handoff §5.1) and MUST stay free of Dianxiaomi-,
 * Lazada-, Alibaba-, Shopify- and AliExpress-specific field names. Everything
 * downstream of a source adapter — validation, matching, preview, publication,
 * media, inventory, storefront projection — speaks only these types, so a
 * future connector implements `CatalogSourceAdapter` and nothing else.
 *
 * A candidate is a PROPOSAL. It is not a website product, and it is not an
 * Alibaba object. Promotion to a canonical Channel product happens only
 * through the merge service, behind operator review.
 */

export type CatalogProvider = 'dianxiaomi' | 'alibaba' | 'aliexpress' | 'lazada' | 'shopify';

/**
 * Integer minor units plus an explicit currency. Money never travels as a
 * float and never travels as a bare number: `Number('1.15') * 100` is
 * `114.999…`, and a currency-less amount is what silently turns CNY into USD.
 */
export interface Money {
  amountMinor: number;
  currency: 'CNY' | 'USD' | string;
}

/**
 * Where a record came from. `sourceProductKey`/`sourceVariantKey` are the
 * deterministic replay keys built by `identity.ts`; the `external*` ids are
 * whatever the provider itself calls the record, kept only for operator
 * traceability and never used as a Channel id.
 */
export interface SourceIdentity {
  provider: CatalogProvider;
  accountKey?: string;
  storeKey?: string;
  externalProductId?: string;
  externalVariantId?: string;
  sourceProductKey: string;
  sourceVariantKey?: string;
}

/** Operator-reviewable signals for matching a candidate to an existing product. */
export interface MatchHints {
  parentSku?: string;
  sku?: string;
  gtin?: string;
  manufacturerPartNumber?: string;
  brand?: string;
}

export interface CandidateCategory {
  sourceTaxonomy: string;
  sourceCategoryId?: string;
  sourceCategoryName?: string;
}

export interface CandidateMedia {
  sourceUrl: string;
  role: 'primary' | 'gallery' | 'variant';
  position: number;
  variantSku?: string;
}

/**
 * One store's reported stock for one variant. Snapshots are never summed by
 * the contract — reconciliation is an explicit decision (`inventory.ts`),
 * because two stores mirroring one warehouse would otherwise double the
 * quantity shown on the website.
 */
export interface InventorySnapshot {
  storeKey?: string;
  quantity: number;
  semantics: 'onHand' | 'sellable' | 'unknown';
  capturedAt?: string;
}

export interface CatalogVariantCandidate {
  identity: SourceIdentity;
  matchHints: MatchHints;
  sku: string;
  optionValues: Record<string, string>;
  sourceRegularPrice?: Money;
  sourcePromotionPrice?: Money;
  inventory: InventorySnapshot[];
  media: CandidateMedia[];
}

/**
 * Which rung of the description fallback chain supplied the copy. Additive and
 * provider-neutral: any source can have an authored description, a short one,
 * or none at all, and a reviewer needs to know which they are looking at
 * before deciding whether it may go public.
 */
export type DescriptionProvenance =
  | 'description'
  | 'shortDescription'
  | 'structured'
  | 'titleAndSpecs'
  | 'none';

export interface CatalogProductCandidate {
  identity: SourceIdentity;
  matchHints: MatchHints;
  parentSku: string;
  title: string;
  brand?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  /** Where `descriptionText` came from; absent means the source's own copy. */
  descriptionSource?: DescriptionProvenance;
  attributes: Record<string, string | number | boolean>;
  category?: CandidateCategory;
  media: CandidateMedia[];
  variants: CatalogVariantCandidate[];
  sourceListingStatus: 'published' | 'draft' | 'missing' | 'unknown';
}

export interface ImportFinding {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  rowNumber?: number;
  parentSku?: string;
  sku?: string;
}

export interface CatalogImportBundle {
  schemaVersion: '1';
  provider: CatalogProvider;
  templateId: string;
  sourceFileSha256: string;
  products: CatalogProductCandidate[];
  findings: ImportFinding[];
  ignoredHeaders: string[];
}

export interface CatalogSourceAdapter<Input> {
  readonly provider: CatalogProvider;
  detect(input: Input): Promise<boolean>;
  parse(input: Input): Promise<CatalogImportBundle>;
}

export const CATALOG_IMPORT_SCHEMA_VERSION = '1' as const;
