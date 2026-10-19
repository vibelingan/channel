import type { CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import type { PublicationCheckpoint } from './catalog-product-operation-api.ts';
import { type PublicationOwner, recoverProductPublication } from './catalog-product-publication.ts';

/** Recovery always addresses an existing owned task. Only Continue may advance it. */
export function ProductPublicationRecovery(props: {
  product: CollectionDoc;
  owner: PublicationOwner;
  checkpoint: PublicationCheckpoint;
  disabled?: boolean;
  onBusy: (busy: boolean) => void;
  onResolved: (product: CollectionDoc, message: string) => void;
}) {
  const [checkpoint, setCheckpoint] = useState(props.checkpoint);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    'Publication is not confirmed. Check its original task before editing this product.',
  );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function act(mode: 'check' | 'continue' | 'cancel') {
    if (busy || props.disabled) return;
    setBusy(true);
    props.onBusy(true);
    try {
      const result = await recoverProductPublication(props.product, props.owner, checkpoint, mode);
      if (!mounted.current) return;
      setCheckpoint(result.checkpoint);
      if (result.product) {
        const text = result.stoppedBeforeStart
          ? 'The product changed before the original publication started. That request cannot publish its old version. Review the current product.'
          : result.item.state === 'confirmed'
            ? 'The original publication is confirmed on the website.'
            : result.item.state === 'cancelled'
              ? 'The original publication is stopped. Review the saved product before editing.'
              : 'The original publication is historical. Review the current product before editing.';
        props.onResolved(result.product, text);
      } else
        setMessage(
          result.item.error?.message ??
            result.item.run?.error?.message ??
            'Publication is still unresolved. Check, continue or stop this original task.',
        );
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error ? error.message : 'The original publication could not be checked.',
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        props.onBusy(false);
      }
    }
  }
  return (
    <section
      aria-label="Product publication recovery"
      className="mt-3 rounded-lg border border-amber-400 p-3"
    >
      <output className="block">{message}</output>
      <p className="mt-2 break-all text-xs">
        Product: {props.product._id} · Original task: {checkpoint.scope.operationId}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(['check', 'continue', 'cancel'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={busy || props.disabled}
            className="min-h-11 rounded-lg border border-amber-400 px-3 font-semibold disabled:opacity-50"
            onClick={() => {
              void act(mode);
            }}
          >
            {mode === 'check'
              ? 'Check publication'
              : mode === 'continue'
                ? 'Continue original publication'
                : 'Stop original publication'}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs">
        Checking does not change the product. Stopping does not undo a publication that already
        completed.
      </p>
    </section>
  );
}
