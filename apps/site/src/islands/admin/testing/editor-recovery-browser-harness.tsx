import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type CollectionDoc, getCollection } from '@vibelingan-channel/shared';
import { StrictMode, useState } from 'react';
import { flushSync } from 'react-dom';
import { type Root, createRoot } from 'react-dom/client';
import { setSession } from '../../../lib/session.ts';
import AdminDetailPreview from '../AdminDetailPreview.tsx';
import { ProductEditForm } from '../ProductEditForm.tsx';
import { getRecord, updateProductFromEditor } from '../api.ts';
import type { PublicationScope } from '../catalog-product-operation-api.ts';
import { createPublicationBatch } from '../catalog-publication-batch.ts';
import { createPublicationJournal } from '../catalog-publication-journal.ts';
import '../../../styles/global.css';
let root: Root | undefined;
export function retainOriginalDraftSave(scope: PublicationScope) {
  const owner = createPublicationBatch().owner;
  createPublicationJournal(owner, undefined, 'draft').retain({ scope });
}
export function setEditorSession(token: string, actorId: string) {
  setSession(token, { id: actorId, email: 'admin@example.test', username: 'Admin', role: 'admin' });
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function target() {
  const container = document.getElementById('editor-recovery-root');
  if (!container) throw Error('Missing editor recovery test root');
  root ??= createRoot(container);
  return root;
}
export function renderPreview(productId: string, token: string) {
  setSession(token, { id: 'admin', email: 'admin@example.test', username: 'Admin', role: 'admin' });
  flushSync(() =>
    target().render(
      <StrictMode>
        <AdminDetailPreview
          productId={productId}
          images={[]}
          sourceImages={false}
          onEdit={() => {
            void renderEditor(productId).catch((error: unknown) => {
              document.body.dataset.editorError =
                error instanceof Error ? error.message : 'Unknown editor error';
            });
          }}
        />
      </StrictMode>,
    ),
  );
}
async function renderEditor(productId: string) {
  const doc = await getRecord('products', productId);
  flushSync(() =>
    target().render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <Editor doc={doc} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}
function Editor({ doc }: { doc: CollectionDoc }) {
  const [current, setCurrent] = useState(doc);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const [closed, setClosed] = useState(false);
  const collection = getCollection('products');
  if (!collection) throw Error('Missing real product registry');
  if (saved) return <output>Draft saved</output>;
  if (closed) return <output>Editor closed</output>;
  return (
    <ProductEditForm
      key={`${current._id}:${current.updatedAt ?? ''}`}
      collection={collection}
      title="Repair saved product"
      initial={current}
      canReviewSupplier={true}
      nativeSaveAvailable={true}
      onRetryAvailability={() => {}}
      onSaved={(product, openEditor) => {
        if (openEditor) setCurrent(product);
        else setSaved(true);
      }}
      submitting={busy}
      error={error}
      onCancel={() => setClosed(true)}
      onSubmit={(values) => {
        setBusy(true);
        setError(null);
        void updateProductFromEditor(current, values)
          .then(() => setSaved(true))
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause : Error('Save failed')),
          )
          .finally(() => setBusy(false));
      }}
    />
  );
}
