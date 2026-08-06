/** Pure storefront catalog DTOs shared by runtime clients and contract tests. */

/**
 * Public projection of an Alibaba-linked product's live source pricing
 * (docs/alibaba-linked-catalog-sync). Amounts are integer MINOR units with an
 * explicit currency — never mix with the legacy major-unit number fields, and
 * never render legacy prices while `alibabaPrimarySourceKey` is set.
 * Offer-provenance identifiers are stripped server-side and never reach this
 * shape.
 */
export interface AlibabaCatalogPricing {
  schemaVersion: string;
  source: 'alibaba';
  currency?: 'CNY' | 'USD';
  mode: 'fixed' | 'range' | 'tiered' | 'negotiable' | 'unavailable';
  amountMinor?: number;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  tiers?: { minQuantity: number; maxQuantity?: number; unitAmountMinor: number }[];
  sourceMoq?: number;
  sourceUpdatedAt?: string;
  syncedAt: string;
}

export type AlibabaSourceStatus = 'available' | 'limited' | 'unavailable' | 'removed' | 'unknown';

export interface Product {
  _id: string;
  name: string;
  category: string;
  series?: string;
  modName?: string;
  modType?: string;
  description?: string;
  productCode?: string;
  moq?: number;
  unitPrice?: number;
  wholesalePrice?: number;
  vipPrice?: number;
  /** Overstock-only fields. */
  inventory?: number;
  clearancePrice?: number;
  /** Image references into the `images` byte collection. */
  imageIds?: string[];
  /** Resolved image URLs (built by the API from `imageIds`). */
  images?: string[];
  /** Alibaba-linked catalog fields — presence of the source key IS the branch. */
  alibabaPrimarySourceKey?: string;
  alibabaCatalogPricing?: AlibabaCatalogPricing;
  alibabaSourceStatus?: AlibabaSourceStatus;
  alibabaSourceLastSyncedAt?: string;
}

export interface CatalogPage {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CatalogQuery {
  categories?: string[];
  search?: string;
  page?: number;
  pageSize?: number;
}
