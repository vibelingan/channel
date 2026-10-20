/** Freeze a server-derived public reference plan; this creates no pending entries or public rights. */
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { PreparedApproval } from './catalog-approval-job.ts';
import {
  CATALOG_IMAGE_REFERENCE_MAX_LEAVES,
  CatalogImageReferenceError,
  type CatalogImageReferencePlan,
  buildCatalogImageReferencePlan,
  catalogImageReferenceProofId,
} from './catalog-image-references.ts';
import {
  type CatalogOwnedApprovalMedia,
  readOwnedApprovalMedia,
} from './catalog-operation-media.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';

const kind = 'catalog-owned-approval-references-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_BINDING_BYTES = 1024;
const DraftReferencesSchema = z
  .object({
    kind: z.literal(kind),
    operationRootId: digest,
    treeRoot: digest,
    leafCount: z.number().int().nonnegative().safe().max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
    bindingDigest: digest,
  })
  .strict();
const LiveReferencesSchema = DraftReferencesSchema.extend({
  kind: z.literal('catalog-owned-live-references-v1'),
  beforeImageIdsDigest: digest,
  afterImageIdsDigest: digest,
}).strict();
export const CatalogOwnedApprovalReferencesSchema = z.discriminatedUnion('kind', [
  DraftReferencesSchema,
  LiveReferencesSchema,
]);
export type CatalogOwnedApprovalReferences = z.infer<typeof CatalogOwnedApprovalReferencesSchema>;
type BindingBody =
  | Omit<z.infer<typeof DraftReferencesSchema>, 'bindingDigest'>
  | Omit<z.infer<typeof LiveReferencesSchema>, 'bindingDigest'>;
type Owner = PreparedApproval & {
  operation: {
    inputDigest: string;
    policy: { preparation: string; media: string; pixels: string };
    intent?: 'publish' | 'refresh-live' | 'save-draft' | 'unpublish' | 'archive';
  };
  media?: CatalogOwnedApprovalMedia | undefined;
};
function adoptedIds(owner: Owner): string[] {
  return catalogReferencedImageIds({
    _id: owner.productId,
    catalogDetailPublication: owner.publication,
  }).sort();
}
function bindingDigest(owner: Owner, commitment: BindingBody) {
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

/** The caller holds the current product in the same transaction as its own approval root. */
export function prepareOwnedApprovalReferences(
  owner: Owner,
  product: CollectionDoc,
): CatalogOwnedApprovalReferences | null {
  const media = readOwnedApprovalMedia(owner, owner.media);
  const live = owner.operation.intent === 'refresh-live';
  if (
    !media ||
    product._id !== owner.productId ||
    (live ? product.published !== true : product.published === true) ||
    (owner.operation.intent !== undefined &&
      !['publish', 'refresh-live'].includes(owner.operation.intent)) ||
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
  let plan: CatalogImageReferencePlan;
  const before = live ? catalogReferencedImageIds(product).sort() : [];
  try {
    plan = buildCatalogImageReferencePlan(owner._id, before, ids);
  } catch (error) {
    if (error instanceof CatalogImageReferenceError) return null;
    throw error;
  }
  const common = {
    operationRootId: owner._id,
    treeRoot: plan.proof.treeRoot,
    leafCount: plan.proof.leafCount,
  };
  const body: BindingBody = live
    ? {
        ...common,
        kind: 'catalog-owned-live-references-v1',
        beforeImageIdsDigest: catalogSealedImageIdsDigest(before),
        afterImageIdsDigest: catalogSealedImageIdsDigest(ids),
      }
    : { ...common, kind };
  const result = CatalogOwnedApprovalReferencesSchema.safeParse({
    ...body,
    bindingDigest: bindingDigest(owner, body),
  });
  return result.success && fitsJsonBudget(result.data, MAX_BINDING_BYTES) ? result.data : null;
}

function readBinding(owner: Owner, value: unknown): CatalogOwnedApprovalReferences | null {
  if (!fitsJsonBudget(value, MAX_BINDING_BYTES) || !readOwnedApprovalMedia(owner, owner.media))
    return null;
  const parsed = CatalogOwnedApprovalReferencesSchema.safeParse(value);
  if (!parsed.success) return null;
  const { bindingDigest: stored, ...body } = parsed.data;
  if (body.operationRootId !== owner._id || stored !== bindingDigest(owner, body)) return null;
  if (body.kind === 'catalog-owned-live-references-v1') {
    if (
      owner.operation.intent !== 'refresh-live' ||
      body.afterImageIdsDigest !== catalogSealedImageIdsDigest(adoptedIds(owner))
    )
      return null;
  } else if (owner.operation.intent !== undefined && owner.operation.intent !== 'publish')
    return null;
  return parsed.data;
}

/** A historical receipt can verify its proof without retaining an unbounded copy of old image IDs.
 * This commitment alone never authorizes staging or a business write; those require the current plan below.
 */
export function readOwnedApprovalReferenceCommitment(
  owner: Owner,
  value: unknown,
): CatalogImageReferencePlan['proof'] | null {
  const binding = readBinding(owner, value);
  if (!binding) return null;
  if (binding.kind === kind) return rebuildPlan(owner, binding)?.proof ?? null;
  const commitment = {
    operationRootId: binding.operationRootId,
    treeRoot: binding.treeRoot,
    leafCount: binding.leafCount,
  };
  return {
    ...commitment,
    _id: catalogImageReferenceProofId(commitment),
    kind: 'catalog-image-reference-commit-v1',
  };
}

/** Rebuild from frozen publication IDs instead of trusting a caller-supplied tree or list. */
export function readOwnedApprovalReferencePlan(
  owner: Owner,
  value: unknown,
  product?: CollectionDoc,
): CatalogImageReferencePlan | null {
  const binding = readBinding(owner, value);
  if (!binding) return null;
  return rebuildPlan(owner, binding, product);
}

function rebuildPlan(
  owner: Owner,
  binding: CatalogOwnedApprovalReferences,
  product?: CollectionDoc,
): CatalogImageReferencePlan | null {
  let before: string[] = [];
  if (binding.kind === 'catalog-owned-live-references-v1') {
    if (
      !product ||
      product._id !== owner.productId ||
      product.published !== true ||
      product.archived === true
    )
      return null;
    before = catalogReferencedImageIds(product).sort();
    if (catalogSealedImageIdsDigest(before) !== binding.beforeImageIdsDigest) return null;
    const after = catalogReferencedImageIds({
      ...product,
      catalogDetailPublication: owner.publication,
    }).sort();
    if (catalogSealedImageIdsDigest(after) !== binding.afterImageIdsDigest) return null;
  }
  try {
    const plan = buildCatalogImageReferencePlan(owner._id, before, adoptedIds(owner));
    return binding.treeRoot === plan.proof.treeRoot && binding.leafCount === plan.proof.leafCount
      ? plan
      : null;
  } catch (error) {
    if (error instanceof CatalogImageReferenceError) return null;
    throw error;
  }
}
