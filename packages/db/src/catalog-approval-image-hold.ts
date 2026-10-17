/** Small, internal image-delete guard; never load approval bodies to answer one image lookup. */
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared/media';

interface Command {
  and(conditions: Record<string, unknown>[]): Record<string, unknown>;
  eq(value: unknown): unknown;
  gt(value: unknown): unknown;
  expr(expression: Record<string, unknown>): Record<string, unknown>;
}
export const APPROVAL_IMAGE_HOLD_PROJECTION: Readonly<Record<string, boolean>> = Object.freeze({
  _id: true,
  productId: true,
});
export function isApprovalImageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}
export function assertApprovalImageLookup(imageId: string, startedAfter: string): void {
  if (
    !isApprovalImageId(imageId) ||
    typeof startedAfter !== 'string' ||
    !Number.isFinite(Date.parse(startedAfter)) ||
    new Date(startedAfter).toISOString() !== startedAfter
  )
    throw new Error('Invalid approval image lookup');
}
export function approvalImageHoldWhere(
  command: Command,
  imageId: string,
  startedAfter: string,
): Record<string, unknown> {
  assertApprovalImageLookup(imageId, startedAfter);
  const contains = (path: string, value: string, limit?: number) => ({
    $cond: [
      { $isArray: `$${path}` },
      { $in: [value, limit === undefined ? `$${path}` : { $slice: [`$${path}`, limit] }] },
      false,
    ],
  });
  return command.and([
    { state: command.eq('staging') },
    { createdAt: command.gt(startedAfter) },
    command.expr({
      $and: [
        { $eq: ['$publication.state', 'approved'] },
        { $eq: ['$publication.header._id', '$productId'] },
        {
          $or: [
            contains('publication.header.images', `/api/images/${imageId}`, 9),
            contains(
              'publication.header.descriptionImages',
              `/api/images/${imageId}`,
              PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
            ),
            contains('publication.variantImageIds', imageId),
          ],
        },
      ],
    }),
  ]);
}
export function firstApprovalImageHold(
  rows: readonly CollectionDoc[],
  imageId: string,
  startedAfter: string,
): string | null {
  if (!isApprovalImageId(imageId)) return null;
  assertApprovalImageLookup(imageId, startedAfter);
  let held: CollectionDoc | undefined;
  for (const row of rows) {
    const productId = typeof row.productId === 'string' ? row.productId : '';
    if (
      row.state === 'staging' &&
      typeof row.createdAt === 'string' &&
      row.createdAt > startedAfter &&
      productId &&
      catalogReferencedImageIds({
        _id: productId,
        catalogDetailPublication: row.publication,
      }).includes(imageId) &&
      (!held || row._id < held._id)
    )
      held = row;
  }
  return held ? String(held.productId) : null;
}
export function approvalImageHoldAnswer(value: unknown): string | null {
  if (!Array.isArray(value) || value.length > 1)
    throw new Error('Approval image lookup was not confirmed');
  if (value.length === 0) return null;
  const row = value[0];
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof row._id !== 'string' ||
    !row._id ||
    typeof row.productId !== 'string' ||
    !row.productId
  )
    throw new Error('Approval image lookup was not confirmed');
  return row.productId;
}
