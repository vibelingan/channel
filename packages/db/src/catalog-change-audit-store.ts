/**
 * Writes for the one-time "changed since approval" audit (MIU-22, runbook R6).
 * Each mark re-reads the product in its own transaction and writes only when
 * the reviewed approval is still current and has no baseline digest yet:
 * `unchanged` records the source digest as the baseline on the receipt;
 * `changed` flags the product for review. Nothing else on the row changes.
 */
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { flagForReview } from './alibaba-product-identity.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import type { ApprovalStageResult } from './catalog-detail-staging.ts';

const id = z.string().trim().min(1).max(200);

export const ChangeAuditMarkSchema = z
  .object({
    action: z.literal('change-audit-mark'),
    productId: id,
    revision: id,
    outcome: z.enum(['unchanged', 'changed']),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  // A plain object: it joins the persistence discriminated union, which cannot
  // hold refinements. The digest rule is checked in `markChangeAudit`.
  .strict();

export async function markChangeAudit(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof ChangeAuditMarkSchema>,
): Promise<ApprovalStageResult> {
  // An unchanged mark records the baseline digest; without one there is nothing to record.
  if (command.outcome === 'unchanged' && command.sourceDigest === undefined)
    return { ok: false, code: 'VALIDATION_ERROR' };
  const actor = await tx.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  const product = await tx.get('products', command.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const skipped = (
    reason: 'revision-changed' | 'already-present' | 'not-approved' | 'archived',
  ): ApprovalStageResult => ({ ok: true, backfill: 'skipped', reason });
  // Archived products leave the catalog and are never flagged (DEC-8).
  if (product.archived === true) return skipped('archived');
  const current = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!current.success || current.data.header._id !== product._id) return skipped('not-approved');
  if (current.data.revision !== command.revision) return skipped('revision-changed');
  const receipt =
    product.catalogDetailApprovalReceipt && typeof product.catalogDetailApprovalReceipt === 'object'
      ? (product.catalogDetailApprovalReceipt as Record<string, unknown>)
      : {};
  if (typeof receipt.sourceDigest === 'string') return skipped('already-present');
  await tx.set(
    'products',
    command.outcome === 'unchanged'
      ? {
          ...product,
          catalogDetailApprovalReceipt: { ...receipt, sourceDigest: command.sourceDigest },
        }
      : { ...product, ...flagForReview(product, 'changed') },
  );
  return { ok: true, backfill: 'applied' };
}
