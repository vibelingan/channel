/** Shared content/config shapes used by the reusable storefront components. */

export interface CategoryOption {
  key: string;
  label: string;
}

/** Strings the catalog list + card components need (shared by all catalogs). */
export interface CatalogListStrings {
  filterLabel: string;
  allLabel: string;
  resultsLabel: string;
  emptyLabel: string;
  /** Placeholder for the catalog search box. */
  searchPlaceholder?: string;
  categories: CategoryOption[];
  wholesaleLabel: string;
  vipLabel: string;
  vipLockedLabel: string;
  moqLabel: string;
  /** Optional stock-status labels (overstock catalogs). */
  statusAvailable?: string;
  statusLow?: string;
  statusSoldOut?: string;
  /** Optional batch-inquiry labels (overstock catalogs). */
  addToInquiry?: string;
  inInquiry?: string;
}

/** Strings the inquiry modal needs. */
export interface InquiryStrings {
  title: string;
  intro: string;
  emailLabel: string;
  companyLabel: string;
  countryLabel: string;
  downloadCatalog: string;
  requestQuote: string;
  submitLabel: string;
  cancelLabel: string;
  successTitle: string;
  successBody: string;
  disclaimer: string;
}

/** Per-catalog configuration passed to the list/detail islands. */
export interface CatalogConfig {
  /** API base path, e.g. "/api/products" or "/api/overstock". */
  apiPath: string;
  /** Detail page route, e.g. "/headphone-item" or "/overstock-item". */
  detailPath: string;
  /** Fallback image when an item has none. */
  fallbackImage: string;
  /** Enable the batch inquiry cart (overstock). */
  enableCart?: boolean;
  /** Show the stock-status badge (overstock). */
  showStock?: boolean;
}
