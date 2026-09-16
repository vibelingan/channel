import {
  type CatalogDetailView,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  DETAIL_COLLECTION_BYTE_LIMIT,
  DETAIL_COLLECTION_PAGE_LIMIT,
  DETAIL_COLLECTION_VARIANT_LIMIT,
  DETAIL_PAGE_BYTE_LIMIT,
} from '../detail-limits.ts';

export interface DetailPages {
  readonly mode: 'collecting' | 'complete' | 'paged';
  readonly currentPage: CatalogDetailView & { revision: string };
  readonly items: readonly CatalogDetailView['variants']['items'][number][];
  readonly retainedBytes: number;
}
export type DetailPagesResult =
  | { status: 'ready'; value: DetailPages }
  | { status: 'invalid-response' | 'refresh-required' | 'limit-exceeded' };

function validBytes(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= DETAIL_PAGE_BYTE_LIMIT;
}

function headerKey(detail: CatalogDetailView): string {
  const { variants: _variants, ...header } = detail;
  // Shared decoding produces a stable key order; compare every approved header field.
  return JSON.stringify(header);
}

export function startDetailPages(input: unknown, bytes: number): DetailPagesResult {
  if (!validBytes(bytes)) return { status: 'limit-exceeded' };
  const decoded = decodeCatalogDetailView(input);
  if (!decoded.ok || !decoded.value.revision || decoded.value.variants.page !== 1) {
    return { status: 'invalid-response' };
  }
  const detail = { ...decoded.value, revision: decoded.value.revision };
  const { total, pageSize, hasMore, items } = detail.variants;
  const paged =
    total > DETAIL_COLLECTION_VARIANT_LIMIT ||
    Math.ceil(total / pageSize) > DETAIL_COLLECTION_PAGE_LIMIT;
  return {
    status: 'ready',
    value: {
      mode: paged ? 'paged' : hasMore ? 'collecting' : 'complete',
      currentPage: detail,
      items,
      retainedBytes: bytes,
    },
  };
}

/** No network or React state here. Errors carry no stale snapshot to accidentally render. */
export function acceptDetailPage(
  current: DetailPages,
  input: unknown,
  bytes: number,
): DetailPagesResult {
  if (!validBytes(bytes)) return { status: 'limit-exceeded' };
  const decoded = decodeCatalogDetailView(input);
  if (!decoded.ok || !decoded.value.revision) return { status: 'invalid-response' };
  const detail = { ...decoded.value, revision: decoded.value.revision };
  const previous = current.currentPage;
  const page = detail.variants;
  if (headerKey(previous) !== headerKey(detail) || previous.variants.total !== page.total) {
    return { status: 'refresh-required' };
  }
  if (
    page.pageSize !== previous.variants.pageSize ||
    page.page > Math.max(1, Math.ceil(page.total / page.pageSize))
  ) {
    return { status: 'invalid-response' };
  }
  if (
    current.mode !== 'paged' &&
    (current.mode === 'complete' || page.page !== previous.variants.page + 1)
  ) {
    return { status: 'invalid-response' };
  }
  // Paged mode retains one page only: validate overlap with that page, never imply global coverage.
  if (page.page !== previous.variants.page) {
    const ids = new Set(current.items.map((v) => v.id));
    if (page.items.some((v) => ids.has(v.id))) return { status: 'invalid-response' };
  }
  if (current.mode === 'paged') {
    return {
      status: 'ready',
      value: { mode: 'paged', currentPage: detail, items: page.items, retainedBytes: bytes },
    };
  }
  if (
    current.retainedBytes + bytes > DETAIL_COLLECTION_BYTE_LIMIT ||
    current.items.length + page.items.length > DETAIL_COLLECTION_VARIANT_LIMIT ||
    page.page > DETAIL_COLLECTION_PAGE_LIMIT
  )
    return { status: 'limit-exceeded' };
  return {
    status: 'ready',
    value: {
      mode: page.hasMore ? 'collecting' : 'complete',
      currentPage: detail,
      items: [...current.items, ...page.items],
      retainedBytes: current.retainedBytes + bytes,
    },
  };
}
