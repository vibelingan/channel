import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getCollection } from '@vibelingan-channel/shared';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductCreateForm } from '../ProductCreateForm.tsx';
import '../../../styles/global.css';

const definition = getCollection('products');
if (!definition) throw Error('Missing product collection');
const collection = definition;
function Harness() {
  const [saved, setSaved] = useState<unknown>();
  return saved ? (
    <>
      <h1>Saved product</h1>
      <pre data-saved-product>{JSON.stringify(saved)}</pre>
    </>
  ) : (
    <ProductCreateForm
      collection={collection}
      title="New Product"
      defaults={{ productFamily: 'misc' }}
      onSaved={(product) => setSaved(product)}
      onCancel={() => setSaved({ cancelled: true })}
    />
  );
}
const root = document.getElementById('product-create-root');
if (!root) throw Error('Missing product creation fixture root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
