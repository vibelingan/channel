import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getCollection } from '@vibelingan-channel/shared';
import { StrictMode, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { setSession } from '../../../lib/session.ts';
import { CollectionView, type ProductClassificationReview } from '../CollectionView.tsx';
import { DASHBOARD_SECTIONS } from '../sections.ts';
import '../../../styles/global.css';
const actor = {
  id: 'admin',
  email: 'admin@example.test',
  username: 'Admin',
  role: 'admin' as const,
};
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function List() {
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState<ProductClassificationReview | null>(null);
  const collection = getCollection('products');
  const section = DASHBOARD_SECTIONS.find((s) => s.collection === 'products');
  if (!collection || !section) throw Error('Missing actual Products definitions');
  return (
    <CollectionView
      collection={collection}
      section={section}
      role={actor.role}
      productSelection={selection}
      onProductSelectionChange={setSelection}
      productReview={review}
      onProductReviewChange={setReview}
    />
  );
}
export function renderList(token: string) {
  setSession(token, actor);
  const node = document.getElementById('catalog-list-root');
  if (!node) throw Error('Missing test root');
  flushSync(() =>
    createRoot(node).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <List />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}

export function hasSettled(scope: string, kind: 'main' | 'count') {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ['list', 'products'] })
    .some((query) => {
      const count = query.queryKey[2] === 'unclassified-count';
      return (
        count === (kind === 'count') &&
        query.queryKey[count ? 3 : 4] === scope &&
        query.state.status === 'success' &&
        query.state.fetchStatus === 'idle'
      );
    });
}
