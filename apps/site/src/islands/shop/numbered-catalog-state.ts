import type { CatalogPage, Product } from './catalog-types.ts';
import type { ProductFamily } from './catalog-types.ts';

export const CATALOG_PAGE_SIZE = 12;

export interface NumberedCatalogQuery {
  readonly page: number;
  readonly search: string;
  readonly categories: readonly string[] | null;
}

export interface NumberedCatalogState {
  readonly generation: number;
  readonly committed: NumberedCatalogQuery | null;
  readonly requested: NumberedCatalogQuery;
  readonly products: readonly Product[];
  readonly total: number | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly recovered: boolean;
}

function normalizeCategories(categories: readonly string[], keys: readonly string[]) {
  if (categories.length === 0 || categories.some((category) => !keys.includes(category))) return [];
  const unique = [...new Set(categories)].sort();
  return unique.length === keys.length ? null : unique;
}

export function parseCatalogQuery(
  search: string,
  categoryKeys: readonly string[],
): NumberedCatalogQuery {
  const params = new URLSearchParams(search);
  const rawPage = params.get('page') ?? '1';
  const page =
    params.getAll('page').length <= 1 &&
    /^[1-9]\d*$/.test(rawPage) &&
    Number.isSafeInteger(Number(rawPage))
      ? Number(rawPage)
      : 1;
  const categories = params.getAll('category');
  return {
    page,
    search: (params.get('search') ?? '').trim(),
    categories:
      categories.length === 0
        ? null
        : categories.length !== 1
          ? []
          : normalizeCategories((categories[0] ?? '').split(','), categoryKeys),
  };
}

export function catalogPagePath(family: ProductFamily, page = 1): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid catalog page');
  return page === 1 ? `/${family}/` : `/${family}/page/${page}/`;
}

export function catalogPathPage(pathname: string): number | null {
  const match = /^\/(?:headphones|ai-gadgets|toys|misc)\/page\/([1-9]\d*)\/?$/.exec(pathname);
  const page = match ? Number(match[1]) : null;
  return page !== null && Number.isSafeInteger(page) ? page : null;
}

export function catalogDeliveredPageCount(bootstrap?: Pick<CatalogPage, 'total'>): number {
  return Math.max(1, Math.ceil((bootstrap?.total ?? 0) / CATALOG_PAGE_SIZE));
}

/** A filtered deep link belongs to the existing root-page interaction, not page N's HTML. */
export function catalogFilteredPathRedirect(href: string): string | null {
  const url = new URL(href);
  const page = catalogPathPage(url.pathname);
  const params = url.searchParams;
  if (
    page === null ||
    !(params.has('category') || params.has('subcategoryIds') || params.get('search')?.trim())
  )
    return null;
  url.pathname = url.pathname.replace(/page\/[1-9]\d*\/?$/, '');
  if (!params.has('page')) params.set('page', String(page));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function catalogDocumentTarget(
  href: string,
  query: NumberedCatalogQuery,
  deliveredPages = Number.POSITIVE_INFINITY,
  renderedPage?: number,
): string | null {
  if (!query.search && query.categories === null && query.page > deliveredPages) return null;
  const url = new URL(href);
  const target = catalogUrl(href, query, true, deliveredPages);
  const samePath =
    new URL(target, url).pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '');
  // Back can change the address to page N while retaining page one's document.
  const supportedDocument =
    renderedPage === undefined || query.page === 1 || query.page === renderedPage;
  return samePath && supportedDocument ? null : target;
}

export function catalogUrl(
  href: string,
  query: NumberedCatalogQuery,
  pathPages = false,
  deliveredPages = Number.POSITIVE_INFINITY,
): string {
  const url = new URL(href);
  url.searchParams.set('page', String(query.page));
  url.searchParams.delete('search');
  if (query.search) url.searchParams.set('search', query.search);
  url.searchParams.delete('category');
  if (query.categories !== null)
    url.searchParams.set(
      'category',
      query.categories.length ? query.categories.join(',') : '__none__',
    );
  const family = /^\/(headphones|ai-gadgets|toys|misc)(?:\/|$)/.exec(url.pathname)?.[1];
  if (pathPages && family) {
    const useStaticPage =
      !query.search && query.categories === null && query.page <= deliveredPages;
    url.pathname = catalogPagePath(family as ProductFamily, useStaticPage ? query.page : 1);
    if (useStaticPage) url.searchParams.delete('page');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function catalogQueryEquals(
  left: NumberedCatalogQuery,
  right: NumberedCatalogQuery,
): boolean {
  return (
    left.page === right.page &&
    left.search === right.search &&
    JSON.stringify(left.categories) === JSON.stringify(right.categories)
  );
}

export function catalogRequestIsPending(
  state: NumberedCatalogState,
  query: NumberedCatalogQuery,
  aborted: boolean,
): boolean {
  return state.pending && !aborted && catalogQueryEquals(state.requested, query);
}

export function catalogQueryWithFilters(
  current: NumberedCatalogQuery,
  search: string,
  categories: readonly string[],
  categoryKeys: readonly string[],
): NumberedCatalogQuery {
  return {
    ...current,
    page: 1,
    search: search.trim(),
    categories: categoryKeys.length
      ? normalizeCategories(categories, categoryKeys)
      : current.categories === null
        ? null
        : [],
  };
}

export function initialNumberedCatalogState(bootstrap?: CatalogPage): NumberedCatalogState {
  const query = { page: bootstrap?.page ?? 1, search: '', categories: null };
  return {
    generation: 0,
    committed: bootstrap ? query : null,
    requested: query,
    products: bootstrap?.items ?? [],
    total: bootstrap?.total ?? null,
    pending: false,
    error: null,
    recovered: false,
  };
}

export function beginNumberedPage(
  state: NumberedCatalogState,
  query: NumberedCatalogQuery,
): NumberedCatalogState {
  return {
    ...state,
    generation: state.generation + 1,
    requested: query,
    pending: true,
    error: null,
    recovered: false,
  };
}

export function cancelNumberedPage(state: NumberedCatalogState): NumberedCatalogState {
  return {
    ...state,
    generation: state.generation + 1,
    requested: state.committed ?? state.requested,
    pending: false,
    error: null,
  };
}

export function failNumberedPage(
  state: NumberedCatalogState,
  generation: number,
  error: string,
): NumberedCatalogState {
  if (state.generation !== generation || !state.pending) return state;
  return { ...state, pending: false, error };
}

export function receiveNumberedPage(
  state: NumberedCatalogState,
  generation: number,
  result: CatalogPage,
  error: string,
): NumberedCatalogState {
  if (state.generation !== generation || !state.pending) return state;
  if (
    result.page !== state.requested.page ||
    result.pageSize !== CATALOG_PAGE_SIZE ||
    !Number.isSafeInteger(result.total) ||
    result.total < 0 ||
    result.items.length > CATALOG_PAGE_SIZE ||
    new Set(result.items.map((product) => product._id)).size !== result.items.length
  )
    return failNumberedPage(state, generation, error);
  const lastPage = Math.max(1, Math.ceil(result.total / CATALOG_PAGE_SIZE));
  if (result.page > lastPage) {
    if (state.recovered || result.items.length > 0)
      return failNumberedPage(state, generation, error);
    return { ...state, requested: { ...state.requested, page: lastPage }, recovered: true };
  }
  if (
    (result.page - 1) * CATALOG_PAGE_SIZE + result.items.length > result.total ||
    (result.items.length === 0 && result.total > 0)
  )
    return failNumberedPage(state, generation, error);
  return {
    ...state,
    committed: state.requested,
    products: result.items,
    total: result.total,
    pending: false,
    error: null,
  };
}

export function catalogPageNumbers(page: number, total: number): number[] {
  const lastPage = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  return [...new Set([1, page - 1, page, page + 1, lastPage])]
    .filter((candidate) => candidate >= 1 && candidate <= lastPage)
    .sort((left, right) => left - right);
}
