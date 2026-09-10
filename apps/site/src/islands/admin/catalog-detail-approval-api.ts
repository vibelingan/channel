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
  review: DetailReview,
  operationId: string,
  signal?: AbortSignal,
) {
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
