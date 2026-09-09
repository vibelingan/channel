import { useEffect, useRef, useState } from 'react';
import {
  type DetailReview,
  approveDetailReview,
  prepareDetailReview,
  readDetailReview,
} from './catalog-detail-approval-api.ts';

/** Works on saved source observations. A successful approval does not publish a draft. */
export function CatalogApprovalPanel({ productId }: { productId: string }) {
  const [review, setReview] = useState<DetailReview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const operation = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  const perform = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await task(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Review failed.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="mt-5 rounded-lg border border-slate-200 bg-white p-4" data-catalog-approval>
      <h3 className="font-semibold">Website detail approval</h3>
      <p className="mt-2 text-sm text-slate-600">
        Review the saved product data and configuration count. Approval updates the website detail
        snapshot; unpublished products remain drafts.
      </p>
      <button
        type="button"
        disabled={busy}
        className="mt-3 min-h-11 rounded border px-4 text-sm font-semibold"
        onClick={() =>
          void perform(async (signal) => {
            setReview(await prepareDetailReview(productId, signal));
            operation.current = undefined;
            setMessage('');
          })
        }
      >
        {busy ? 'Working…' : 'Prepare detail review'}
      </button>
      {review && (
        <div className="mt-4 space-y-3">
          <p className="font-semibold">{review.detail.name}</p>
          <p className="text-sm">
            {review.detail.images.length} gallery images · {review.detail.variants.total}{' '}
            configurations
          </p>
          <ul className="max-h-56 overflow-y-auto text-sm">
            {review.detail.variants.items.map((v) => (
              <li className="border-t py-2" key={v.id}>
                {v.sku || 'Configuration'} —{' '}
                {v.options.map((o) => `${o.name}: ${o.value}`).join(' · ')}
              </li>
            ))}
          </ul>
          {review.detail.variants.hasMore && (
            <button
              type="button"
              disabled={busy}
              className="min-h-11 underline"
              onClick={() =>
                void perform(async (signal) =>
                  setReview(
                    await readDetailReview(
                      productId,
                      review.detail.variants.page + 1,
                      review.expectedDigest,
                      signal,
                    ),
                  ),
                )
              }
            >
              Next configurations
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className="min-h-11 rounded bg-brand-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() =>
              void perform(async (signal) => {
                operation.current ??= crypto.randomUUID();
                await approveDetailReview(review, operation.current, signal);
                setMessage('Website detail approved. Draft publication is unchanged.');
              })
            }
          >
            Approve website detail
          </button>
        </div>
      )}
      {message && <output className="mt-3 block text-sm text-green-800">{message}</output>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
