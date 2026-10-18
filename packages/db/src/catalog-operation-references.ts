/** Freeze a server-derived public reference plan; this creates no pending entries or public rights. */
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { PreparedApproval } from './catalog-approval-job.ts';
import {
  CATALOG_IMAGE_REFERENCE_MAX_LEAVES,
  type CatalogImageReferencePlan,
  buildCatalogImageReferencePlan,
} from './catalog-image-references.ts';
import {
  type CatalogOwnedApprovalMedia,
  readOwnedApprovalMedia,
} from './catalog-operation-media.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';

const kind = 'catalog-owned-approval-references-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_BINDING_BYTES = 1024;
export const CatalogOwnedApprovalReferencesSchema = z
  .object({
    kind: z.literal(kind),
    operationRootId: digest,
    treeRoot: digest,
    leafCount: z.number().int().nonnegative().safe().max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
    bindingDigest: digest,
  })
  .strict();
export type CatalogOwnedApprovalReferences = z.infer<typeof CatalogOwnedApprovalReferencesSchema>;
type Owner = PreparedApproval & {
  operation: {
    inputDigest: string;
    policy: { preparation: string; media: string; pixels: string };
  };
  media?: CatalogOwnedApprovalMedia | undefined;
};
function adoptedIds(owner: Owner): string[] {
  return catalogReferencedImageIds({
    _id: owner.productId,
    catalogDetailPublication: owner.publication,
  }).sort();
}
function bindingDigest(
  owner: Owner,
  commitment: Omit<CatalogOwnedApprovalReferences, 'bindingDigest'>,
) {
  return alibabaPricingFingerprint([
    kind,
    owner._id,
    owner.productId,
    owner.operation.inputDigest,
    owner.operation.policy,
    owner.revision,
    owner.productFingerprint,
    owner.media?.bindingDigest,
    commitment,
  ]);
}

/** The caller already holds the current unpublished product and its own durable approval root. */
export function prepareOwnedApprovalReferences(
  owner: Owner,
  product: CollectionDoc,
): CatalogOwnedApprovalReferences | null {
  const media = readOwnedApprovalMedia(owner, owner.media);
  if (
    !media ||
    product._id !== owner.productId ||
    product.published === true ||
    product.archived === true
  )
    return null;
  const ids = catalogReferencedImageIds({
    ...product,
    catalogDetailPublication: owner.publication,
  }).sort();
  if (
    ids.length !== media.ready.imageCount ||
    catalogSealedImageIdsDigest(ids) !== media.ready.imageIdsDigest
  )
    return null;
  const plan = buildCatalogImageReferencePlan(owner._id, [], ids);
  const body: Omit<CatalogOwnedApprovalReferences, 'bindingDigest'> = {
    kind,
    operationRootId: owner._id,
    treeRoot: plan.proof.treeRoot,
    leafCount: plan.proof.leafCount,
  };
  const result = { ...body, bindingDigest: bindingDigest(owner, body) };
  return fitsJsonBudget(result, MAX_BINDING_BYTES) ? result : null;
}

/** Rebuild from frozen publication IDs instead of trusting a caller-supplied tree or list. */
export function readOwnedApprovalReferencePlan(
  owner: Owner,
  value: unknown,
): CatalogImageReferencePlan | null {
  if (!fitsJsonBudget(value, MAX_BINDING_BYTES) || !readOwnedApprovalMedia(owner, owner.media))
    return null;
  const parsed = CatalogOwnedApprovalReferencesSchema.safeParse(value);
  if (!parsed.success) return null;
  const { bindingDigest: stored, ...body } = parsed.data;
  const plan = buildCatalogImageReferencePlan(owner._id, [], adoptedIds(owner));
  return body.operationRootId === owner._id &&
    body.treeRoot === plan.proof.treeRoot &&
    body.leafCount === plan.proof.leafCount &&
    stored === bindingDigest(owner, body)
    ? plan
    : null;
}
