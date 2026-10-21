import { useEffect, useRef, useState } from 'react';
import {
  type PhotoPreparationStatus,
  fetchPhotoPreparationStatus,
  prepareAlibabaPhotos,
  syncProduct,
} from './alibaba-api.ts';

export function photoFailureText(reason: string): string {
  if (reason === 'not-found')
    return 'The source server denied access or no longer provides this image (403/404/410).';
  if (reason === 'too-large') return 'The source image exceeds the upload size limit.';
  if (reason === 'bad-content') return 'The source did not return a supported image.';
  if (reason === 'fetch-failed') return 'The image download failed or timed out.';
  if (reason === 'write-failed')
    return 'The image could not be saved. Retry; contact the site administrator if this continues.';
  return 'The image could not be copied safely. Retry or replace it in the product.';
}
export function AlibabaPhotoIssues({ onOpenProduct }: { onOpenProduct?: (id: string) => void }) {
  const [status, setStatus] = useState<PhotoPreparationStatus | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const epoch = ++generation.current;
    void fetchPhotoPreparationStatus(true)
      .then((value) => {
        if (mounted.current && generation.current === epoch) setStatus(value);
      })
      .catch(() => {
        if (mounted.current && generation.current === epoch)
          setMessage('Photo details could not be loaded. Use Retry below.');
      })
      .finally(() => {
        if (mounted.current && generation.current === epoch) setBusy(null);
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const retry = async (issue?: NonNullable<PhotoPreparationStatus['issues']>[number]) => {
    if (running.current) return;
    running.current = true;
    generation.current++;
    setBusy(issue?.productId ?? 'load');
    setMessage(null);
    try {
      if (issue) {
        if (issue.sourceProductId) {
          const result = await syncProduct(issue.sourceProductId);
          if (result.productId !== issue.productId)
            throw Error(
              'The source linked to a different product. Open Products and review the source link.',
            );
        }
        await prepareAlibabaPhotos(undefined, {
          productId: issue.productId,
          retryUnavailable: true,
        });
      }
      const next = await fetchPhotoPreparationStatus(true);
      if (mounted.current) {
        setStatus(next);
        setMessage(
          issue
            ? next.issues?.some((row) => row.productId === issue.productId)
              ? 'Some images are still unavailable. Replace the affected image on Alibaba, then retry, or open the product and upload a replacement.'
              : 'Images checked. Open the product to review the result before publishing.'
            : null,
        );
      }
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error
            ? error.message
            : 'Retry could not be confirmed. Reload the photo details before trying again.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <section
      aria-label="Products with unavailable photos"
      className="rounded-lg border border-amber-200 bg-white p-5 space-y-4"
    >
      <h3 className="text-base font-semibold text-slate-900">Products with unavailable photos</h3>
      <p className="text-sm text-slate-600">
        Retry refreshes this product from Alibaba and checks its photos. Your website categories and
        manually edited photos are kept. If an image is still unavailable, replace it on Alibaba or
        upload a replacement in the product editor.
      </p>
      {message && <output className="block text-sm text-amber-800">{message}</output>}
      {!status && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void retry()}
          className="min-h-11 rounded-lg border px-4 py-2"
        >
          {busy ? 'Loading…' : 'Retry loading photo details'}
        </button>
      )}
      {status?.issues?.map((issue) => (
        <article key={issue.productId} className="border-t border-slate-100 pt-4 space-y-2">
          <p className="font-medium text-slate-900">{issue.name}</p>
          <p className="text-sm text-slate-600 break-all">
            Alibaba product ID: {issue.sourceProductId || 'Unavailable'}
          </p>
          <ul className="space-y-2 text-sm">
            {issue.photos.map((photo) => (
              <li key={`${photo.part}:${photo.position}:${photo.sourceUrl}`}>
                <span>
                  {photo.part === 'configurations'
                    ? 'Variant'
                    : photo.part === 'description'
                      ? 'Description'
                      : 'Gallery'}{' '}
                  image {photo.position}: {photoFailureText(photo.reason)}{' '}
                </span>
                <a
                  href={photo.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline break-all"
                >
                  Open source image
                </a>
              </li>
            ))}
          </ul>
          {issue.photos.length === 0 && (
            <p className="text-sm text-amber-800">
              The saved photo summary needs a fresh check. Retry this product to identify the
              current unavailable images.
            </p>
          )}
          {issue.truncated && (
            <p className="text-sm text-amber-800">
              Showing the first 200 affected images. Open the product to review all variants.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void retry(issue)}
              className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm"
            >
              {busy === issue.productId ? 'Retrying…' : 'Retry this product'}
            </button>
            {onOpenProduct && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onOpenProduct(issue.productId)}
                className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm"
              >
                Open product
              </button>
            )}
          </div>
        </article>
      ))}
      {status && status.draftsMissingPhotos === 0 && (
        <output>No products need photo review.</output>
      )}
      {status && status.draftsMissingPhotos > (status.issues?.length ?? 0) && (
        <p className="text-sm text-slate-600">
          Showing the first {status.issues?.length ?? 0} of {status.draftsMissingPhotos} affected
          products. Resolve these and reload to see the next products.
        </p>
      )}
    </section>
  );
}
