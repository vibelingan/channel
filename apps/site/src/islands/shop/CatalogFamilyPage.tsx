import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { CatalogContent, CatalogFamilyContent } from '../../i18n/catalog.ts';
import { CatalogFamilyGrid } from './CatalogFamilyGrid.tsx';
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

  return (
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
    />
  );
}
