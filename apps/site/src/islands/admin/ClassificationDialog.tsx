import type { CollectionDoc } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { ProductClassificationEditor } from './ProductClassificationEditor.tsx';
import { useModalDialog } from './use-modal-dialog.ts';

export function ClassificationDialog({
  products,
  publishOnSave = false,
  onClose,
  onSaved,
}: {
  products: readonly CollectionDoc[];
  publishOnSave?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useModalDialog();
  const [busy, setBusy] = useState(false);
  return (
    <dialog
      ref={dialog}
      aria-label="Edit website classification"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 shadow-xl backdrop:bg-slate-900/40"
    >
      <ProductClassificationEditor
        products={products}
        publishOnSave={publishOnSave}
        onBusyChange={setBusy}
        onCancel={onClose}
        onSaved={onSaved}
      />
    </dialog>
  );
}
