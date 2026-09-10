import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { catalogApprovalCall } from './api.ts';
const progress = z
  .object({
    ok: z.literal(true),
    jobId: z.string(),
    revision: z.string(),
    nextPage: z.number().int().min(0).max(500),
    pages: z.number().int().min(0).max(500),
    complete: z.boolean(),
  })
  .strict();
const review = z
  .object({
    ok: z.literal(true),
    kind: z.literal('review'),
    productId: z.string(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRevision: z.string().nullable(),
    detail: z.unknown(),
    previewMedia: z
      .object({
        galleryIds: z.array(z.string()).max(9),
        descriptionIds: z.array(z.string()).max(18),
        gallerySources: z.array(z.string()).max(9),
        descriptionSources: z.array(z.string()).max(18),
        importDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        variantSources: z
          .array(
            z
              .object({
                id: z.string(),
                sources: z.array(z.string().url()).max(9),
                unboundSources: z.array(z.string().url()).max(9),
              })
              .strict(),
          )
          .max(50)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function prepareDetailReview(productId: string, signal?: AbortSignal) {
  let page = 0;
  for (let attempts = 0; attempts < 500; attempts++) {
    const result = progress.parse(
      await catalogApprovalCall({ action: 'prepare', productId, page }, signal),
    );
    if (result.complete) return readDetailReview(productId, 1, undefined, signal);
    if (result.nextPage <= page || result.nextPage >= result.pages)
      throw new Error('Preparation did not advance. Refresh and retry.');
    page = result.nextPage;
  }
  throw new Error('Product exceeds preparation limits.');
}
export async function readDetailReview(
  productId: string,
  page: number,
  expectedDigest?: string,
  signal?: AbortSignal,
) {
  const result = review.parse(
    await catalogApprovalCall(
      {
        action: 'review',
        productId,
        page,
        includePreviewMedia: true,
        ...(expectedDigest ? { expectedDigest } : {}),
      },
      signal,
    ),
  );
  const detail = decodeCatalogDetailView(result.detail);
  if (!detail.ok || detail.value._id !== productId)
    throw new Error('Invalid product review response.');
  return { ...result, detail: detail.value };
}
export type DetailReview = Awaited<ReturnType<typeof readDetailReview>>;
export async function approveDetailReview(
  initialReview: DetailReview,
  operationId: string,
  signal?: AbortSignal,
) {
  let review = initialReview;
  // Conversion to owned media is an explicit approval step, never a Preview side effect.
  // Import only the source mappings the operator just reviewed. Re-read and fail
  // closed if any non-media content, source mapping or published revision changed.
  const pendingSources = (review.previewMedia?.variantSources ?? []).flatMap(
    (entry) => entry.unboundSources,
  );
  if (review.previewMedia?.importDigest) {
    for (
      let page = 2;
      page <= Math.ceil(review.detail.variants.total / review.detail.variants.pageSize);
      page++
    ) {
      const next = await readDetailReview(review.productId, page, review.expectedDigest, signal);
      pendingSources.push(
        ...(next.previewMedia?.variantSources ?? []).flatMap((entry) => entry.unboundSources),
      );
    }
  }
  if (pendingSources.length) {
    const { importAlibabaSourceImage } = await import('./alibaba-catalog-sync/alibaba-api.ts');
    for (const url of new Set(pendingSources)) {
      signal?.throwIfAborted();
      await importAlibabaSourceImage(url, signal);
    }
    const next = await prepareDetailReview(review.productId, signal);
    if (
      !review.previewMedia?.importDigest ||
      next.previewMedia?.importDigest !== review.previewMedia.importDigest
    )
      throw new Error(
        'The product changed while importing configuration photos. Refresh and review it again.',
      );
    review = next;
  }
  let result = progress.parse(
    await catalogApprovalCall(
      {
        action: 'begin',
        command: {
          productId: review.productId,
          expectedDigest: review.expectedDigest,
          expectedRevision: review.expectedRevision,
          operationId,
        },
      },
      signal,
    ),
  );
  for (
    let attempts = 0;
    !result.complete && result.nextPage < result.pages && attempts < 500;
    attempts++
  ) {
    const next = progress.parse(
      await catalogApprovalCall(
        { action: 'page', jobId: result.jobId, page: result.nextPage },
        signal,
      ),
    );
    if (next.jobId !== result.jobId || next.nextPage <= result.nextPage)
      throw new Error('Approval did not advance. Retry the same review.');
    result = next;
  }
  if (!result.complete)
    result = progress.parse(
      await catalogApprovalCall({ action: 'finish', jobId: result.jobId }, signal),
    );
  if (!result.complete) throw new Error('Approval was not confirmed.');
  return result;
}
