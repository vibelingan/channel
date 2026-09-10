import { useEffect, useRef, useState } from 'react';
import type { DetailPages } from '../../catalog/application/catalog-detail-pages.ts';
import { resolveVariantSelection } from '../../catalog/application/catalog-variant-state.ts';
import { CatalogDescriptionImages } from '../../catalog/presentation/CatalogDescriptionImages.tsx';
import { CatalogDetail } from '../../catalog/presentation/CatalogDetail.tsx';
import { CatalogVariantGallery } from '../../catalog/presentation/CatalogVariantGallery.tsx';
import { getSharedDetailContent } from '../../i18n/catalog.ts';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import {
  type DetailReview,
  prepareDetailReview,
  readDetailReview,
} from './catalog-detail-approval-api.ts';
import { useAdminImagePreviews } from './use-admin-image-previews.ts';

/** Uses the same validated detail DTO and components as the buyer, without publication or RFQ. */
export default function AdminDetailPreview({
  productId,
  images,
  sourceImages,
  descriptionImages = [],
}: {
  productId: string;
  images: readonly string[];
  sourceImages: boolean;
  descriptionImages?: readonly string[];
}) {
  const [review, setReview] = useState<DetailReview>();
  const [error, setError] = useState('');
  const [requestPage, setRequestPage] = useState({ page: 1 });
  const page = requestPage.page;
  const digest = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<string>();
  const media = review?.previewMedia;
  const imagePreview = useAdminImagePreviews([
    ...(review?.detail.variants.items.flatMap((v) =>
      v.images.map((src) => src.slice('/api/images/'.length)),
    ) ?? []),
    ...(media?.galleryIds ?? []),
    ...(media?.descriptionIds ?? []),
  ]);
  const owned = imagePreview.urls;
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
  const galleryImages = media
    ? media.galleryIds.length
      ? media.galleryIds.flatMap((id) => (owned[id] ? [owned[id]] : []))
      : alibabaSourcePreviewUrls(media.gallerySources)
    : images;
  const detailImages = media
    ? media.descriptionIds.length
      ? media.descriptionIds.flatMap((id) => (owned[id] ? [owned[id]] : []))
      : alibabaSourcePreviewUrls(media.descriptionSources, 18)
    : descriptionImages;
  return (
    <>
      <p className="mx-6 mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Preview of saved changes using the website layout. Viewing does not publish this product or
        submit an inquiry.
        {sourceImages &&
          ' Images shown are from Alibaba. In Edit, import the source gallery before publishing.'}
      </p>
      {imagePreview.failed > 0 && (
        <div
          role="alert"
          className="mx-6 mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {imagePreview.failed} images could not be loaded. Saved images have not been removed.
          <button type="button" onClick={imagePreview.retry} className="ml-3 min-h-11 underline">
            Retry images
          </button>
        </div>
      )}
      <CatalogDetail
        pages={pages}
        selection={selection}
        copy={getSharedDetailContent()}
        inquiryEnabled={false}
        descriptionMedia={
          media ? (
            detailImages.length ? (
              <CatalogDescriptionImages images={detailImages} />
            ) : null
          ) : descriptionImages.length ? (
            <CatalogDescriptionImages images={descriptionImages} />
          ) : undefined
        }
        backNavigation={null}
        onSelect={setSelected}
        onClear={() => setSelected(undefined)}
        media={
          <CatalogVariantGallery
            images={galleryImages}
            name={review.detail.name}
            productId={productId}
            revision={review.expectedDigest}
            selection={selection}
            variants={pages.items}
            loadingImages={imagePreview.loading}
            resolveImage={(src) => owned[src.slice('/api/images/'.length)]}
            sourceImages={
              selection.status === 'selected'
                ? alibabaSourcePreviewUrls(
                    media?.variantSources?.find((m) => m.id === selection.variant.id)?.sources ??
                      [],
                  )
                : []
            }
            unavailableLabel="Product image unavailable"
          />
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
