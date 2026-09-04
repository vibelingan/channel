/**
 * Read model for the Catalog Import preview.
 *
 * The preview is READ-ONLY and rides the existing generic admin API: both
 * `catalogImportJobs` and `catalogImportItems` are registered with
 * `adminAccess: 'readOnly'`, so listing them needs no new server action and no
 * new authorization path. `productVariants` and `catalogSourceLinks` are
 * `adminAccess: 'none'` and are deliberately NOT read here — everything the
 * preview shows is already embedded in the staged item.
 *
 * The functions below are pure and separated from the components so the
 * formatting rules that matter (CNY is labelled as CNY; a conflicting stock
 * count renders as a conflict rather than as a number) can be tested without a
 * DOM.
 */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { listRecords } from '../api.ts';

export interface SourceMoney {
  amountMinor: number;
  currency: string;
}

export interface StoreListingView {
  storeKey: string;
  sku: string;
  sourceListingStatus: string;
  marketplaceProductId: string;
  regularPrice: SourceMoney | null;
  promotionPrice: SourceMoney | null;
  quantity: number | null;
  rowNumber: number;
}

export interface VariantView {
  sku: string;
  optionSummary: string;
  regularPrice: SourceMoney | null;
  promotionPrice: SourceMoney | null;
  inventoryLabel: string;
  inventoryConflict: boolean;
  imageUrls: string[];
}

export interface ProductView {
  id: string;
  parentSku: string;
  title: string;
  status: string;
  sourceListingStatus: string;
  descriptionText: string;
  hasDescription: boolean;
  imageUrls: string[];
  variants: VariantView[];
  storeListings: StoreListingView[];
  findings: FindingView[];
}

export interface FindingView {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  rowNumber: number | null;
  sku: string;
}

export interface JobView {
  id: string;
  provider: string;
  status: string;
  sourceFileName: string;
  sourceFileSha256: string;
  templateId: string;
  sheetName: string;
  startedAt: string;
  counts: Record<string, number>;
  summary: Record<string, number>;
  ignoredHeaders: string[];
  errorSummary: string;
  sourceEvidenceStatus: 'retained' | 'absent' | 'unknown';
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function asRecordOfNumbers(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function asMoney(value: unknown): SourceMoney | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const amountMinor = record.amountMinor;
  const currency = record.currency;
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return null;
  return { amountMinor, currency: typeof currency === 'string' ? currency : 'CNY' };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Render source money with its currency ALWAYS attached. A bare "1,299.00" in
 * an admin table that also shows USD prices elsewhere is exactly how a CNY
 * number ends up believed to be dollars.
 */
export function formatSourceMoney(money: SourceMoney | null): string {
  if (money === null) return '—';
  const major = (money.amountMinor / 100).toFixed(2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${money.currency} ${grouped}`;
}

/**
 * Inventory label. A conflict and an unknown both render as words, never as a
 * number: the merchant asked for an exact count, and a count nobody can source
 * is worse than no count at all.
 */
export function formatInventory(resolution: unknown): { label: string; conflict: boolean } {
  if (typeof resolution !== 'object' || resolution === null) {
    return { label: 'unknown', conflict: false };
  }
  const record = resolution as Record<string, unknown>;
  if (record.state === 'known' && typeof record.quantity === 'number') {
    return { label: String(record.quantity), conflict: false };
  }
  if (record.state === 'conflict') {
    const quantities = Array.isArray(record.quantities) ? record.quantities.join(', ') : '';
    return { label: `conflicting (${quantities})`, conflict: true };
  }
  return { label: 'unknown', conflict: false };
}

export function toJobView(doc: CollectionDoc): JobView {
  const hasSourceEvidencePointer = [
    doc.sourceStorageFileId,
    doc.retainedSourceStorageFileId,
    doc.orphanedSourceStorageFileId,
  ].some((value) => typeof value === 'string' && value !== '');
  const failureCode = asString(doc.failureCode);
  const sourceEvidenceStatus = hasSourceEvidencePointer
    ? 'retained'
    : failureCode === 'source-evidence-attach-failed'
      ? 'absent'
      : 'unknown';
  return {
    id: doc._id,
    provider: asString(doc.provider),
    status: asString(doc.status),
    sourceFileName: asString(doc.sourceFileName),
    sourceFileSha256: asString(doc.sourceFileSha256),
    templateId: asString(doc.templateId),
    sheetName: asString(doc.sheetName),
    startedAt: asString(doc.startedAt),
    counts: asRecordOfNumbers(doc.counts),
    summary: asRecordOfNumbers(doc.summary),
    ignoredHeaders: asStringArray(doc.ignoredHeaders),
    errorSummary: asString(doc.errorSummary),
    sourceEvidenceStatus,
  };
}

export function toProductView(doc: CollectionDoc): ProductView {
  const candidate = (doc.candidate ?? {}) as Record<string, unknown>;
  const rawVariants = Array.isArray(candidate.variants) ? candidate.variants : [];
  const inventory = Array.isArray(doc.inventory) ? doc.inventory : [];
  const inventoryByKey = new Map<string, unknown>();
  for (const entry of inventory) {
    const record = entry as Record<string, unknown>;
    if (typeof record.candidateSkuKey === 'string') {
      inventoryByKey.set(record.candidateSkuKey, record.resolution);
    }
  }

  const variants: VariantView[] = rawVariants.map((raw) => {
    const variant = raw as Record<string, unknown>;
    const identity = (variant.identity ?? {}) as Record<string, unknown>;
    const options = (variant.optionValues ?? {}) as Record<string, unknown>;
    const resolution = inventoryByKey.get(asString(identity.sourceVariantKey));
    const { label, conflict } = formatInventory(resolution);
    return {
      sku: asString(variant.sku),
      optionSummary: Object.entries(options)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join(', '),
      regularPrice: asMoney(variant.sourceRegularPrice),
      promotionPrice: asMoney(variant.sourcePromotionPrice),
      inventoryLabel: label,
      inventoryConflict: conflict,
      imageUrls: (Array.isArray(variant.media) ? variant.media : [])
        .map((media) => asString((media as Record<string, unknown>).sourceUrl))
        .filter((url) => url !== ''),
    };
  });

  const storeListings: StoreListingView[] = (
    Array.isArray(doc.storeListings) ? doc.storeListings : []
  ).map((raw) => {
    const listing = raw as Record<string, unknown>;
    return {
      storeKey: asString(listing.storeKey),
      sku: asString(listing.sku),
      sourceListingStatus: asString(listing.sourceListingStatus),
      marketplaceProductId: asString(listing.externalProductId),
      regularPrice: asMoney(listing.sourceRegularPrice),
      promotionPrice: asMoney(listing.sourcePromotionPrice),
      quantity: asNumberOrNull(listing.quantity),
      rowNumber: asNumberOrNull(listing.rowNumber) ?? 0,
    };
  });

  const findings: FindingView[] = (Array.isArray(doc.findings) ? doc.findings : []).map((raw) => {
    const finding = raw as Record<string, unknown>;
    return {
      severity: finding.severity === 'error' ? 'error' : 'warning',
      code: asString(finding.code),
      message: asString(finding.message),
      rowNumber: asNumberOrNull(finding.rowNumber),
      sku: asString(finding.sku),
    };
  });

  // `descriptionText`, never `descriptionHtml`. The sanitized markup is stored
  // for a later operator-approved rendering path; the preview will not be the
  // thing that calls dangerouslySetInnerHTML on supplier input.
  const descriptionText = asString(candidate.descriptionText);

  return {
    id: doc._id,
    parentSku: asString(doc.parentSku),
    title: asString(doc.title),
    status: asString(doc.status),
    sourceListingStatus: asString(doc.sourceListingStatus),
    descriptionText,
    hasDescription: descriptionText.trim() !== '',
    imageUrls: (Array.isArray(candidate.media) ? candidate.media : [])
      .map((media) => asString((media as Record<string, unknown>).sourceUrl))
      .filter((url) => url !== ''),
    variants,
    storeListings,
    findings,
  };
}

export async function fetchImportJobs(limit = 25): Promise<JobView[]> {
  const page = await listRecords({
    collection: 'catalogImportJobs',
    page: 1,
    pageSize: limit,
    sort: [{ field: 'startedAt', dir: 'desc' }],
  });
  return page.items.map(toJobView);
}

/** The generic admin list action caps a page at 100 rows. */
export const MAX_PREVIEW_ITEMS = 100;

export interface ImportItemPage {
  products: ProductView[];
  total: number;
  /** True when the job staged more products than one page can show. */
  truncated: boolean;
}

export async function fetchImportItems(
  jobId: string,
  limit = MAX_PREVIEW_ITEMS,
): Promise<ImportItemPage> {
  const page = await listRecords({
    collection: 'catalogImportItems',
    page: 1,
    pageSize: Math.min(limit, MAX_PREVIEW_ITEMS),
    filter: { combinator: 'and', clauses: [{ field: 'jobId', op: 'eq', value: jobId }] },
    sort: [{ field: 'parentSku', dir: 'asc' }],
  });
  return {
    products: page.items.map(toProductView),
    total: page.total,
    truncated: page.total > page.items.length,
  };
}
