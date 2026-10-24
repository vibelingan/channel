import type { CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { getRecord } from './api.ts';
import { useModalDialog } from './use-modal-dialog.ts';

export function ProductRecordLoader({
  productId,
  onLoaded,
  onClose,
}: {
  productId: string;
  onLoaded: (product: CollectionDoc) => void;
  onClose: () => void;
}) {
  const dialog = useModalDialog();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onLoaded, onClose });
  callbacks.current = { onLoaded, onClose };

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the read after an explicit retry.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        const product = await getRecord('products', productId, controller.signal);
        if (active) callbacks.current.onLoaded(product);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [productId, attempt]);

  return (
    <dialog
      ref={dialog}
      aria-label="Load product"
      aria-busy={!failed}
      onCancel={(event) => {
        event.preventDefault();
        callbacks.current.onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl backdrop:bg-slate-900/40"
    >
      <h2 className="text-lg font-semibold">Opening product</h2>
      {failed ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          This product could not be loaded. Retry, or close and reopen it.
        </p>
      ) : (
        <output className="mt-3 block text-sm text-slate-600">Loading the saved product…</output>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {failed && (
          <button
            type="button"
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold"
            onClick={() => {
              setFailed(false);
              setAttempt((current) => current + 1);
            }}
          >
            Retry load
          </button>
        )}
        <button
          type="button"
          className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold"
          onClick={() => callbacks.current.onClose()}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
