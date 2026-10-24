import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getCollection } from '@vibelingan-channel/shared';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollectionView, type ProductClassificationReview } from '../CollectionView.tsx';
import { DASHBOARD_SECTIONS } from '../sections.ts';
import '../../../styles/global.css';
const definition = getCollection('products');
const foundSection = DASHBOARD_SECTIONS.find((section) => section.collection === 'products');
if (!definition || !foundSection) throw Error('Product collection and section are required');
const collection = definition;
const section = foundSection;
const actorRole = 'admin';
function Harness() {
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [review, setReview] = useState<ProductClassificationReview | null>(null);
  return (
    <CollectionView
      collection={collection}
      section={section}
      role={actorRole}
      productSelection={selection}
      onProductSelectionChange={setSelection}
      productReview={review}
      onProductReviewChange={setReview}
    />
  );
}
const root = document.getElementById('table-publication-root');
if (!root) throw Error('Missing table publication fixture root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
        })
      }
    >
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
