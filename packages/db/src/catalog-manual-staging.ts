/**
 * Prepare for a manual product (MIU-28): the same approval pipeline as a synced
 * product, with an empty candidate the planner fills from the row (MIU-27). One
 * transaction of three operations: actor read, product read, product write.
 *
 * Approval reads configuration rows only from this manifest, which is empty, so
 * a product that has configuration rows (only the not-yet-live Excel import
 * creates them) is refused rather than approved without them (DESIGN §5.2).
 * The server lists those rows before calling; browsers never call this command.
 */
import { manualDetailCandidate } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import type { ApprovalStageResult } from './catalog-detail-staging.ts';
import { sourceDigest } from './catalog-source-staging.ts';

const id = z.string().trim().min(1).max(200);

export const ManualSourceSchema = z
  .object({
    action: z.literal('manual-source'),
    productId: id,
    /** Active configuration rows of the product, listed by the server. */
    configurationRowIds: z.array(id).max(10000),
  })
  .strict();

export async function prepareManualSource(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ManualSourceSchema>,
): Promise<ApprovalStageResult> {
  const actor = await tx.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  if (command.configurationRowIds.length > 0) return { ok: false, code: 'VALIDATION_ERROR' };
  const product = await tx.get('products', command.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const linked =
    typeof product.alibabaPrimarySourceKey === 'string' && product.alibabaPrimarySourceKey !== '';
  if (linked || product.archived === true) return { ok: false, code: 'CONFLICT' };
  const revision = sourceDigest(['manual', product._id, 'v1']);
  // A product unlinked from Alibaba must not carry its old source fingerprint
  // into a manual approval.
  const { detailSourcePublicDigest: _previous, ...current } = product;
  await tx.set('products', {
    ...current,
    detailSourceOwner: `manual:${product._id}`,
    detailSourceRevision: revision,
    detailSourceManifest: { revision, variantIds: [] },
    detailSourceNextPage: 1,
    detailSourceReady: true,
    detailSourceCandidate: manualDetailCandidate({
      _id: product._id,
      name: typeof product.name === 'string' ? product.name : '',
    }),
    detailSourceContentCandidate: null,
    detailSourceNoteBlocksCandidate: null,
  });
  return { ok: true, jobId: revision, revision, nextPage: 1, pages: 1, complete: true };
}
