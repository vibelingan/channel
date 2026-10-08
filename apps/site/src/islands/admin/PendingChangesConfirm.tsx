import type { CollectionDoc } from '@vibelingan-channel/shared';

/**
 * Batch Publish shows no product details, so before it re-approves live
 * products with pending Alibaba changes the admin confirms or skips them
 * (DEC-12, MIU-35).
 */
export function PendingChangesConfirm({
  flagged,
  othersCount,
  busy,
  onContinue,
  onSkip,
  onCancel,
}: {
  flagged: readonly CollectionDoc[];
  othersCount: number;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  return (
    <fieldset
      aria-label="Confirm publishing pending Alibaba changes"
      className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
    >
      <p className="font-semibold">
        {flagged.length} selected live {flagged.length === 1 ? 'product has' : 'products have'}{' '}
        Alibaba changes you have not reviewed. Publishing also approves their pending Alibaba
        changes.
      </p>
      <ul className="mt-2 list-disc pl-5">
        {flagged.map((doc) => (
          <li key={doc._id}>{String(doc.name ?? doc._id)}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-4">
        <button type="button" disabled={busy} className="font-semibold" onClick={onContinue}>
          Continue
        </button>
        {othersCount > 0 && (
          <button type="button" disabled={busy} onClick={onSkip}>
            Skip those
          </button>
        )}
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}
