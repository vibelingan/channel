import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CatalogContent,
  CatalogFamilyContent,
  SharedDetailContent,
} from '../../i18n/catalog.ts';
import { CatalogFamilyGrid } from './CatalogFamilyGrid.tsx';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import { LegacySkuDetailPage } from './SkuDetailPage.tsx';
import { fetchCatalog } from './api.ts';
import {
  type PublicCatalogTaxonomy,
  fetchCatalogTaxonomy,
  parseTaxonomyCatalogQuery,
} from './catalog-taxonomy.ts';
import {
  CATALOG_PAGE_SIZE,
  type NumberedCatalogQuery,
  type NumberedCatalogState,
  beginNumberedPage,
  cancelNumberedPage,
  catalogQueryEquals,
  catalogQueryWithFilters,
  catalogRequestIsPending,
  catalogUrl,
  failNumberedPage,
  initialNumberedCatalogState,
  parseCatalogQuery,
  receiveNumberedPage,
} from './numbered-catalog-state.ts';

interface Props {
  content: CatalogContent;
  family: CatalogFamilyContent;
  previewContent?: SharedDetailContent;
}

const SharedCatalogPreview = lazy(() => import('./SharedCatalogPreview.tsx'));

function detailIsOpen() {
  const params = new URLSearchParams(window.location.search);
  return ['id', 'variant', 'slug'].some((key) => params.has(key));
}

function writeCatalogHistory(query: NumberedCatalogQuery, mode: 'push' | 'replace') {
  if (detailIsOpen()) return;
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.delete('subcategoryIds');
  const next = catalogUrl(currentUrl.href, query);
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`)
    return;
  window.history[mode === 'push' ? 'pushState' : 'replaceState'](window.history.state, '', next);
}

export function CatalogFamilyPage({ content, family, previewContent }: Props) {
  if (SharedCatalogPreview && previewContent)
    return (
      <Suspense fallback={<output>{content.list.loadingLabel}</output>}>
        <SharedCatalogPreview
          copy={previewContent}
          renderLegacyDetail={(productId) => (
            <LegacySkuDetailPage content={content} productId={productId} />
          )}
          renderList={(open, locationSearch) => (
            <CatalogFamilyList
              key={family.key}
              content={content}
              family={family}
              onOpenProduct={open}
              locationSearch={locationSearch}
            />
          )}
        />
      </Suspense>
    );
  return <CatalogFamilyList key={family.key} content={content} family={family} />;
}

type ListProps = Props & { onOpenProduct?: (id: string) => void; locationSearch?: string };

function CatalogFamilyList(props: ListProps) {
  const { family } = props;
  const [attempt, setAttempt] = useState(0);
  const taxonomyGenerationRef = useRef(0);
  const [loaded, setLoaded] = useState<{
    source: CatalogFamilyContent;
    family: CatalogFamilyContent;
    registry: PublicCatalogTaxonomy | null;
    error: string | null;
    pending: boolean;
  }>(() => ({
    source: family,
    family: { ...family, categories: [] },
    registry: null,
    error: null,
    pending: true,
  }));
  const retryTaxonomy = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    taxonomyGenerationRef.current = attempt;
    setLoaded((current) =>
      current.source === family
        ? { ...current, pending: true, error: null }
        : {
            source: family,
            family: { ...family, categories: [] },
            registry: null,
            error: null,
            pending: true,
          },
    );
    void fetchCatalogTaxonomy(family.key, controller.signal).then(
      (registry) => {
        if (controller.signal.aborted || taxonomyGenerationRef.current !== attempt) return;
        setLoaded({
          source: family,
          family: {
            ...family,
            label: registry.name,
            heading: registry.name,
            categories: registry.children.map((child) => ({ key: child.id, label: child.name })),
          },
          registry,
          error: null,
          pending: false,
        });
      },
      () => {
        if (controller.signal.aborted || taxonomyGenerationRef.current !== attempt) return;
        setLoaded((current) => ({
          ...current,
          pending: false,
          error: 'Unable to load catalog categories.',
        }));
      },
    );
    return () => controller.abort();
  }, [family, attempt]);

  return (
    <CatalogFamilyController
      {...props}
      family={loaded.family}
      registry={loaded.registry}
      taxonomyError={loaded.error}
      taxonomyPending={loaded.pending}
      onTaxonomyRetry={retryTaxonomy}
    />
  );
}

function CatalogFamilyController({
  content,
  family,
  onOpenProduct,
  locationSearch,
  registry,
  taxonomyError,
  taxonomyPending,
  onTaxonomyRetry,
}: ListProps & {
  registry: PublicCatalogTaxonomy | null;
  taxonomyError: string | null;
  taxonomyPending: boolean;
  onTaxonomyRetry: () => void;
}) {
  const categoryKeys = family.categories.map((category) => category.key);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(categoryKeys);
  const [searchInput, setSearchInput] = useState('');
  const [state, setState] = useState<NumberedCatalogState>(initialNumberedCatalogState);
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const invalidSelectionRef = useRef(false);
  const listTopRef = useRef<HTMLDivElement>(null);
  const focusGenerationRef = useRef<number | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  // The card that opened the detail band; focus returns here on Back.
  const originCardIdRef = useRef<string | null>(null);
  // Bumped on every activation so re-opening the same card still moves focus.
  const [openToken, setOpenToken] = useState(0);

  const commit = useCallback((next: NumberedCatalogState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const restoreInputs = useCallback(
    (query: NumberedCatalogQuery) => {
      setSearchInput(query.search);
      setSelectedCategories(
        query.categories === null
          ? family.categories.map((category) => category.key)
          : [...query.categories],
      );
    },
    [family.categories],
  );

  const navigate = useCallback(
    async (query: NumberedCatalogQuery, mode: 'push' | 'replace', focus = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const current = stateRef.current;
      const loading = beginNumberedPage(
        mode === 'replace' ? { ...current, committed: null, products: [], total: null } : current,
        query,
      );
      commit(loading);
      focusGenerationRef.current = focus ? loading.generation : null;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const requested = stateRef.current.requested;
          const result =
            requested.categories?.length === 0
              ? { items: [], total: 0, page: requested.page, pageSize: CATALOG_PAGE_SIZE }
              : await fetchCatalog(
                  '/api/products',
                  {
                    productFamily: family.key,
                    ...(requested.categories === null
                      ? {}
                      : { subcategoryIds: [...requested.categories] }),
                    ...(requested.search ? { search: requested.search } : {}),
                    page: requested.page,
                    pageSize: CATALOG_PAGE_SIZE,
                  },
                  controller.signal,
                );
          if (controller.signal.aborted || stateRef.current.generation !== loading.generation)
            return;
          const next = receiveNumberedPage(
            stateRef.current,
            loading.generation,
            result,
            content.list.errorLabel,
          );
          commit(next);
          if (next.pending) continue;
          if (next.error) {
            if (next.committed) {
              restoreInputs(next.committed);
              writeCatalogHistory(next.committed, 'replace');
            }
          } else if (next.committed) {
            setActiveProductId(null);
            writeCatalogHistory(next.committed, mode);
          }
          return;
        }
      } catch {
        if (controller.signal.aborted || stateRef.current.generation !== loading.generation) return;
        const failed = failNumberedPage(
          stateRef.current,
          loading.generation,
          content.list.errorLabel,
        );
        commit(failed);
        if (failed.committed) {
          restoreInputs(failed.committed);
          writeCatalogHistory(failed.committed, 'replace');
        }
      }
    },
    [commit, content.list.errorLabel, family.key, restoreInputs],
  );

  const readLocation = useCallback(() => {
    if (taxonomyPending && registry === null) return;
    let query: NumberedCatalogQuery;
    try {
      query = parseTaxonomyCatalogQuery(window.location.search, registry);
      invalidSelectionRef.current = false;
    } catch (error) {
      invalidSelectionRef.current = true;
      abortRef.current?.abort();
      const failed = cancelNumberedPage(stateRef.current);
      commit({
        ...failed,
        committed: null,
        requested: { ...parseCatalogQuery(window.location.search, []), categories: [] },
        products: [],
        total: null,
        pending: taxonomyPending,
        error: taxonomyPending
          ? null
          : error instanceof Error
            ? error.message
            : content.list.errorLabel,
      });
      setSelectedCategories([]);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (
      params.has('page') &&
      (params.getAll('page').length !== 1 || params.get('page') !== String(query.page))
    )
      writeCatalogHistory(query, 'replace');
    const current = stateRef.current;
    if (
      catalogRequestIsPending(current, query, abortRef.current?.signal.aborted ?? true) &&
      (current.committed === null || catalogQueryEquals(current.committed, query))
    )
      return;
    restoreInputs(query);
    if (current.committed && catalogQueryEquals(current.committed, query)) {
      abortRef.current?.abort();
      if (current.pending || current.error) commit(cancelNumberedPage(current));
      return;
    }
    void navigate(query, 'replace');
  }, [commit, content.list.errorLabel, registry, taxonomyPending, navigate, restoreInputs]);

  useEffect(() => {
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => {
      window.removeEventListener('popstate', readLocation);
      abortRef.current?.abort();
    };
  }, [readLocation]);

  useEffect(() => {
    if (locationSearch !== undefined) readLocation();
  }, [locationSearch, readLocation]);

  useEffect(() => {
    if (
      state.pending ||
      state.error ||
      state.committed === null ||
      focusGenerationRef.current !== state.generation
    )
      return;
    focusGenerationRef.current = null;
    if (detailIsOpen() || activeProductId) return;
    listTopRef.current?.focus({ preventScroll: true });
    listTopRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [state, activeProductId]);

  const handleRetry = () => {
    const current = stateRef.current;
    if (current.pending || detailIsOpen()) return;
    if (invalidSelectionRef.current) {
      onTaxonomyRetry();
      return;
    }
    restoreInputs(current.requested);
    void navigate(current.requested, current.committed ? 'push' : 'replace');
  };

  const handlePageChange = (page: number) => {
    const current = stateRef.current;
    if (
      current.pending ||
      !current.committed ||
      detailIsOpen() ||
      page === current.committed.page ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > Math.max(1, Math.ceil((current.total ?? 0) / CATALOG_PAGE_SIZE))
    )
      return;
    restoreInputs(current.committed);
    void navigate({ ...current.committed, page }, 'push', true);
  };

  const handleFilters = (search: string, categories: string[], categoriesChanged = false) => {
    if (detailIsOpen() || (invalidSelectionRef.current && !categoriesChanged)) return;
    if (categories.some((category) => !categoryKeys.includes(category))) return;
    setSearchInput(search);
    setSelectedCategories(categories);
    const current = stateRef.current;
    const query: NumberedCatalogQuery = {
      page: 1,
      search: search.trim(),
      categories: categoriesChanged
        ? categories.length === 0
          ? []
          : catalogQueryWithFilters(current.requested, search, categories, categoryKeys).categories
        : current.requested.categories,
    };
    if (invalidSelectionRef.current) writeCatalogHistory(query, 'replace');
    invalidSelectionRef.current = false;
    if (catalogQueryEquals(current.requested, query) && !current.error) return;
    void navigate(query, 'push');
  };

  const handleClearFilters = () => {
    if (detailIsOpen()) return;
    const query: NumberedCatalogQuery = { page: 1, search: '', categories: null };
    setSearchInput('');
    setSelectedCategories(categoryKeys);
    writeCatalogHistory(query, 'replace');
    invalidSelectionRef.current = false;
    void navigate(query, 'push');
  };

  const handleOpenProduct = useCallback(
    (productId: string) => {
      const current = stateRef.current;
      if (!current.products.some((product) => product._id === productId)) return;
      focusGenerationRef.current = null;
      if (current.pending) {
        abortRef.current?.abort();
        commit(cancelNumberedPage(current));
        if (current.committed) restoreInputs(current.committed);
      }
      if (onOpenProduct) {
        onOpenProduct(productId);
        return;
      }
      originCardIdRef.current = productId;
      setOpenToken((token) => token + 1);
      setActiveProductId(productId);
    },
    [commit, onOpenProduct, restoreInputs],
  );

  const handleBack = useCallback(() => {
    const originId = originCardIdRef.current;
    setActiveProductId(null);
    requestAnimationFrame(() => {
      if (!originId) return;
      const card = document.querySelector<HTMLElement>(
        `[data-product-card="${CSS.escape(originId)}"]`,
      );
      card?.focus();
      card?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
      originCardIdRef.current = null;
    });
  }, []);

  const activeProduct =
    activeProductId === null
      ? null
      : (state.products.find((product) => product._id === activeProductId) ?? null);

  // Move focus to the detail heading once the expanded band has mounted.
  useEffect(() => {
    if (openToken === 0 || !activeProduct) return;
    const heading = document.querySelector<HTMLElement>('[data-detail-heading]');
    heading?.focus();
    heading?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [openToken, activeProduct]);

  const categoryLabel =
    family.categories.find((category) => category.key === activeProduct?.category)?.label ??
    activeProduct?.category ??
    '';

  return (
    <>
      {taxonomyError && !invalidSelectionRef.current && (
        <div role="alert" className="mt-8 border border-red-200 bg-red-50 p-6 text-sm text-red-800">
          <p>{taxonomyError}</p>
          <button
            type="button"
            onClick={onTaxonomyRetry}
            disabled={taxonomyPending}
            className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 font-semibold hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            {content.list.retryLabel}
          </button>
        </div>
      )}
      <div ref={listTopRef} tabIndex={-1} data-catalog-list-top>
        <CatalogFamilyGrid
          content={content}
          family={family}
          state={state}
          selectedCategories={selectedCategories}
          searchInput={searchInput}
          onCategoriesChange={(categories) => handleFilters(searchInput, categories, true)}
          onSearchInputChange={(search) => handleFilters(search, selectedCategories)}
          onRetry={handleRetry}
          onPageChange={handlePageChange}
          onOpenProduct={handleOpenProduct}
        />
        {invalidSelectionRef.current && state.error && (
          <button
            type="button"
            onClick={handleClearFilters}
            className="mt-4 min-h-11 border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
          >
            Clear filters
          </button>
        )}
      </div>
      {activeProduct && (
        <HeadphonesProductDetail
          product={activeProduct}
          detail={content.detail}
          categoryLabel={categoryLabel}
          onBack={handleBack}
        />
      )}
    </>
  );
}
