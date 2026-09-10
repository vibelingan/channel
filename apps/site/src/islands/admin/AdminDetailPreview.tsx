import { useEffect, useRef, useState } from 'react';
import type { DetailPages } from '../../catalog/application/catalog-detail-pages.ts';
import { resolveVariantSelection } from '../../catalog/application/catalog-variant-state.ts';
import { CatalogDetail } from '../../catalog/presentation/CatalogDetail.tsx';
import { getSharedDetailContent } from '../../i18n/catalog.ts';
import { Gallery } from '../shop/Gallery.tsx';
import {
  type DetailReview,
  prepareDetailReview,
  readDetailReview,
} from './catalog-detail-approval-api.ts';

/** Uses the same validated detail DTO and components as the buyer, without publication or RFQ. */
export default function AdminDetailPreview({
  productId,
  images,
  sourceImages,
}: {
  productId: string;
  images: readonly string[];
  sourceImages: boolean;
}) {
  const [review, setReview] = useState<DetailReview>();
  const [error, setError] = useState('');
  const [requestPage, setRequestPage] = useState({ page: 1 });
  const page = requestPage.page;
  const digest = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const request =
      requestPage.page === 1
        ? prepareDetailReview(productId, controller.signal)
        : readDetailReview(productId, requestPage.page, digest.current, controller.signal);
    void request
      .then((next) => {
        if (!controller.signal.aborted) {
          setReview(next);
          digest.current = next.expectedDigest;
          setSelected(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Product preview could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [productId, requestPage]);
  if (error)
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800"
      >
        <p>{error}</p>
        <button
          type="button"
          className="mt-3 min-h-11 underline"
          onClick={() => {
            setRequestPage({ page: 1 });
          }}
        >
          Retry product preview
        </button>
      </div>
    );
  if (busy || !review)
    return (
      <output className="block p-8 text-sm text-slate-600">
        Loading product images, configurations and prices…
      </output>
    );
  const pages: DetailPages = {
    mode: review.detail.variants.hasMore || page > 1 ? 'paged' : 'complete',
    currentPage: { ...review.detail, revision: `admin-preview-${review.expectedDigest}` },
    items: review.detail.variants.items,
    retainedBytes: JSON.stringify(review.detail).length,
  };
  const selection = resolveVariantSelection(pages, selected ?? pages.items[0]?.id);
  return (
    <>
      <p className="mx-6 mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Preview of saved changes using the website layout. Viewing does not publish this product or
        submit an inquiry.
        {sourceImages &&
          ' Images shown are from Alibaba. In Edit, import the source gallery before publishing.'}
      </p>
      <CatalogDetail
        pages={pages}
        selection={selection}
        copy={getSharedDetailContent()}
        inquiryEnabled={false}
        backNavigation={null}
        onSelect={setSelected}
        onClear={() => setSelected(undefined)}
        media={
          <Gallery images={images} alt={review.detail.name} productId={productId} layout="detail" />
        }
        pagination={
          pages.mode === 'paged' ? (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <button
                type="button"
                className="min-h-11 rounded-lg border px-3 disabled:opacity-50"
                disabled={page <= 1}
                onClick={() => setRequestPage({ page: page - 1 })}
              >
                Previous configurations
              </button>
              <span>
                Page {page} of{' '}
                {Math.max(
                  1,
                  Math.ceil(review.detail.variants.total / review.detail.variants.pageSize),
                )}
              </span>
              <button
                type="button"
                className="min-h-11 rounded-lg border px-3 disabled:opacity-50"
                disabled={!review.detail.variants.hasMore}
                onClick={() => setRequestPage({ page: page + 1 })}
              >
                Next configurations
              </button>
            </div>
          ) : undefined
        }
      />
    </>
  );
}
