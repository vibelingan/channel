/** Reuse a completed private preparation receipt; this does not approve or publish. */
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import {
  CatalogPreparationReadySealSchema,
  readCurrentCatalogPreparation,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { PreparedApproval } from './catalog-approval-job.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { readCompletedCatalogPreparation } from './catalog-preparation-finish.ts';
import { readCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const policy = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const kind = 'catalog-owned-approval-media-v1';
// Historical receipts remain readable after a policy change; eligibility checks compare the operation policy.
const HistoricalReadySealSchema = CatalogPreparationReadySealSchema.extend({
  mediaPolicyVersion: policy,
  pixelPolicyVersion: policy,
});
export const CatalogOwnedApprovalMediaSchema = z
  .object({
    kind: z.literal(kind),
    preparationInputDigest: digest,
    ready: HistoricalReadySealSchema,
    bindingDigest: digest,
  })
  .strict();
export type CatalogOwnedApprovalMedia = z.infer<typeof CatalogOwnedApprovalMediaSchema>;
type MediaOwner = Pick<
  PreparedApproval,
  '_id' | 'productId' | 'productFingerprint' | 'revision' | 'publication'
> & {
  operation: {
    inputDigest: string;
    policy: { preparation: string; media: string; pixels: string };
  };
};
const MAX_BINDING_BYTES = 2048;
function adoptedIds(owner: MediaOwner): string[] {
  return catalogReferencedImageIds({
    _id: owner.productId,
    catalogDetailPublication: owner.publication,
  }).sort();
}
function bindingDigest(owner: MediaOwner, value: Omit<CatalogOwnedApprovalMedia, 'bindingDigest'>) {
  return alibabaPricingFingerprint([
    kind,
    owner._id,
    owner.productId,
    owner.operation.inputDigest,
    owner.operation.policy,
    owner.revision,
    owner.productFingerprint,
    value,
  ]);
}
export function readOwnedApprovalMedia(
  owner: MediaOwner,
  value: unknown,
): CatalogOwnedApprovalMedia | null {
  if (!fitsJsonBudget(value, MAX_BINDING_BYTES)) return null;
  const parsed = CatalogOwnedApprovalMediaSchema.safeParse(value);
  if (!parsed.success) return null;
  const media = parsed.data;
  const { bindingDigest: stored, ...body } = media;
  const ids = adoptedIds(owner);
  if (
    stored !== bindingDigest(owner, body) ||
    media.ready.imageCount !== ids.length ||
    media.ready.imageIdsDigest !== catalogSealedImageIdsDigest(ids) ||
    media.ready.mediaPolicyVersion !== owner.operation.policy.media ||
    media.ready.pixelPolicyVersion !== owner.operation.policy.pixels
  )
    return null;
  return media;
}

/** The approval root is already durable and holds the same adopted images before this transfer. */
export async function prepareOwnedApprovalMedia(
  tx: CatalogApprovalTransaction,
  owner: MediaOwner,
  product: CollectionDoc,
): Promise<CatalogOwnedApprovalMedia | null> {
  const initial = readCurrentCatalogPreparation(product);
  if (
    initial?.state !== 'ready' ||
    initial.productId !== owner.productId ||
    initial.policyVersion !== owner.operation.policy.preparation
  )
    return null;
  const raw = await tx.get('catalogPreparationJobs', initial.seal.jobId);
  const job = readCatalogPreparationJob(raw, initial.seal.jobId, Date.now());
  if (!job || job.productId !== owner.productId || job.state !== 'completed') return null;
  const completed = await readCompletedCatalogPreparation(tx, job);
  if (
    !completed.ok ||
    !('report' in completed) ||
    completed.report.state !== 'ready' ||
    alibabaPricingFingerprint(completed.report) !== alibabaPricingFingerprint(initial)
  )
    return null;
  const body: Omit<CatalogOwnedApprovalMedia, 'bindingDigest'> = {
    kind,
    preparationInputDigest: initial.inputDigest,
    ready: initial.seal,
  };
  return readOwnedApprovalMedia(owner, { ...body, bindingDigest: bindingDigest(owner, body) });
}
