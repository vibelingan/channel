import type { CollectionDoc } from '@vibelingan-channel/shared';
import { splitPendingSupplierChanges } from './review-reason.ts';
import { useModalDialog } from './use-modal-dialog.ts';

/**
 * Batch Publish shows no product details, so before it re-approves live
 * products with pending Alibaba changes the admin confirms or skips them
 * (DEC-12, MIU-35). A modal dialog: the selection cannot change underneath it.
 */
export function PendingChangesConfirm({
  docs,
  busy,
  onPublishAll,
  onPublishOthers,
  onCancel,
}: {
  /** The selected products this confirmation is about. */
  docs: readonly CollectionDoc[];
  busy: boolean;
  onPublishAll: () => void;
  onPublishOthers: () => void;
  onCancel: () => void;
}) {
  const dialog = useModalDialog();
  const [flagged, others] = splitPendingSupplierChanges(docs);
  const button =
    'min-h-11 rounded-lg px-4 text-sm font-semibold disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand-600';
  return (
    <dialog
      ref={dialog}
      aria-labelledby="pending-changes-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950 shadow-xl backdrop:bg-slate-900/40"
    >
      <h2 id="pending-changes-title" className="font-semibold">
        {flagged.length} selected live {flagged.length === 1 ? 'product has' : 'products have'}{' '}
        Alibaba changes you have not reviewed. Publishing also approves their pending Alibaba
        changes.
      </h2>
      <ul className="mt-2 list-disc pl-5">
        {flagged.map((doc) => (
          <li key={doc._id}>{String(doc.name ?? doc._id)}</li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={`${button} bg-slate-900 text-white`}
          onClick={onPublishAll}
        >
          Publish all {docs.length}
        </button>
        {others.length > 0 && (
          <button
            type="button"
            disabled={busy}
            className={`${button} border border-slate-300 bg-white`}
            onClick={onPublishOthers}
          >
            Publish the other {others.length} only
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          className={`${button} border border-slate-300 bg-white`}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}
