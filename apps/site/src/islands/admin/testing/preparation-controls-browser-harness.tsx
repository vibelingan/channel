import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { type Root, createRoot } from 'react-dom/client';
import { setSession } from '../../../lib/session.ts';
import AdminDetailPreview from '../AdminDetailPreview.tsx';
import { CatalogPreparationControls } from '../CatalogPreparationControls.tsx';
import '../../../styles/global.css';
let root: Root | undefined;
let ready = 0;
export function signIn(id: string, role: 'admin' | 'contributor' = 'admin') {
  setSession('owned-browser-token', { id, email: 'owned@example.test', username: id, role });
}
export function renderControls(productId: string) {
  const container = document.getElementById('preparation-test-root');
  if (!container) throw Error('Missing preparation browser fixture root');
  root ??= createRoot(container);
  flushSync(() =>
    root?.render(
      <StrictMode>
        <CatalogPreparationControls
          productId={productId}
          onEdit={() => {
            document.body.dataset.editedProduct = productId;
          }}
          onReady={() => {
            document.body.dataset.readyCount = String(++ready);
          }}
        />
      </StrictMode>,
    ),
  );
}

export function renderSavedPreview(productId: string) {
  const container = document.getElementById('preparation-test-root');
  if (!container) throw Error('Missing preparation browser fixture root');
  root ??= createRoot(container);
  flushSync(() =>
    root?.render(
      <StrictMode>
        <AdminDetailPreview
          productId={productId}
          images={[]}
          sourceImages={false}
          onEdit={() => {
            document.body.dataset.editedProduct = productId;
          }}
        />
      </StrictMode>,
    ),
  );
}
