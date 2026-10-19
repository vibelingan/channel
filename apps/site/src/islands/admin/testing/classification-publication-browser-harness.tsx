import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { ProductClassificationEditor } from '../ProductClassificationEditor.tsx';
import '../../../styles/global.css';
const products = z
  .array(z.object({ _id: z.string() }).passthrough())
  .parse(await (await fetch(`/classification-products${location.search}`)).json());
function Harness() {
  const [closed, setClosed] = useState(false);
  return closed ? (
    <p>Classification closed</p>
  ) : (
    <ProductClassificationEditor
      products={products}
      onSaved={() => setClosed(true)}
      onCancel={() => setClosed(true)}
      onUnresolved={() => {}}
    />
  );
}
const container = document.getElementById('classification-publication-root');
if (!container) throw Error('Missing classification publication fixture root');
createRoot(container).render(
  <StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
