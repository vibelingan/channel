import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import { CatalogFamilyGrid } from './CatalogFamilyGrid.tsx';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import { fetchCatalog } from './api.ts';
import {
  type HeadphonesCatalogState,
  beginInitialLoad,
  beginLoadMore,
  commitCatalogPage,
  failInitialLoad,
  failLoadMore,
  initialHeadphonesCatalogState,
  resetCatalogGeneration,
  setActiveProduct,
} from './headphonesCatalogState.ts';

interface Props {
  content: CatalogContent;
  family: CatalogFamilyContent;
}

const PAGE_SIZE = 12;

export function CatalogFamilyPage({ content, family }: Props) {
  const categoryKeys = family.categories.map((category) => category.key);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(categoryKeys);
  const [searchInput, setSearchInput] = useState('');
  const search = useDeferredValue(searchInput.trim());
  const [state, setState] = useState<HeadphonesCatalogState>(initialHeadphonesCatalogState);
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  // The card that opened the detail band; focus returns here on Back.
  const originCardIdRef = useRef<string | null>(null);
  // Bumped on every activation so re-opening the same card still moves focus.
  const [openToken, setOpenToken] = useState(0);
  stateRef.current = state;

  const commit = useCallback((next: HeadphonesCatalogState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const loadPage = useCallback(
    (generation: number, page: number, initial: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const categories =
        family.categories.length === 0 || selectedCategories.length === categoryKeys.length
          ? undefined
          : selectedCategories;

      fetchCatalog(
        '/api/products',
        {
          productFamily: family.key,
          ...(categories ? { categories } : {}),
          ...(search ? { search } : {}),
          page,
          pageSize: PAGE_SIZE,
        },
        controller.signal,
      )
        .then((result) => setState((current) => commitCatalogPage(current, generation, result)))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.error('[catalog-family] page failed', error);
          setState((current) =>
            initial
              ? failInitialLoad(current, generation, content.list.errorLabel)
              : failLoadMore(current, generation, content.list.errorLabel),
          );
        });
    },
    [
      categoryKeys.length,
      content.list.errorLabel,
      family.categories.length,
      family.key,
      search,
      selectedCategories,
    ],
  );

  useEffect(() => {
    const loading = beginInitialLoad(resetCatalogGeneration(stateRef.current));
    commit(loading);
    if (family.categories.length > 0 && selectedCategories.length === 0) {
      setState((current) =>
        commitCatalogPage(current, loading.generation, {
          items: [],
          total: 0,
          page: 1,
          pageSize: PAGE_SIZE,
        }),
      );
      return () => abortRef.current?.abort();
    }
    loadPage(loading.generation, 1, true);
    return () => abortRef.current?.abort();
  }, [commit, family.categories.length, loadPage, selectedCategories.length]);

  const handleRetryInitial = useCallback(() => {
    const current = stateRef.current;
    if (current.status === 'loading-initial' || current.status === 'loading-more') return;
    const loading = beginInitialLoad(current);
    commit(loading);
    loadPage(loading.generation, 1, true);
  }, [commit, loadPage]);

  const handleLoadMore = useCallback(() => {
    const current = stateRef.current;
    const loading = beginLoadMore(current);
    if (loading === current) return;
    commit(loading);
    loadPage(loading.generation, loading.nextPage, false);
  }, [commit, loadPage]);

  const handleOpenProduct = useCallback(
    (productId: string) => {
      originCardIdRef.current = productId;
      setOpenToken((token) => token + 1);
      commit(setActiveProduct(stateRef.current, productId));
    },
    [commit],
  );

  const handleBack = useCallback(() => {
    const originId = originCardIdRef.current;
    commit(setActiveProduct(stateRef.current, null));
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
  }, [commit]);

  const activeProduct =
    state.activeProductId === null
      ? null
      : (state.products.find((product) => product._id === state.activeProductId) ?? null);

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
      <CatalogFamilyGrid
        content={content}
        family={family}
        state={state}
        selectedCategories={selectedCategories}
        searchInput={searchInput}
        onCategoriesChange={setSelectedCategories}
        onSearchInputChange={setSearchInput}
        onRetryInitial={handleRetryInitial}
        onLoadMore={handleLoadMore}
        onOpenProduct={handleOpenProduct}
      />
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
