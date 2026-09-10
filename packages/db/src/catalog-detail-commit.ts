/** Server-only approval persistence. Does not publish, change source data, or send notifications. */
import { createHash, randomUUID } from 'node:crypto';
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { z } from 'zod';
import { readImageMutationState } from './adapter.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
export const CatalogApprovalManifestSchema = z
  .object({
    revision: identity,
    variantIds: z
      .array(identity)
      .max(10000)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const CatalogApprovalCommandSchema = z
  .object({
    productId: identity,
    operationId: z.string().uuid(),
    expectedRevision: identity.nullable(),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CatalogApprovalResult =
  | { ok: true; productId: string; revision: string; variants: number; replayed: boolean }
  | {
      ok: false;
      code:
        | 'VALIDATION_ERROR'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'SOURCE_NOT_READY'
        | 'MEDIA_NOT_READY'
        | 'APPROVAL_TOO_LARGE';
    };
export interface CatalogApprovalTransaction {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  /** Replace an existing row, including its unchanged private fields. Throw on any failed write. */
  set(collection: string, row: CollectionDoc): Promise<void>;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Digest the exact reviewable plan, not opaque unrelated source evidence or a mutable timestamp. */
export function catalogApprovalDigest(product: CollectionDoc, variants: CollectionDoc[]): string {
  const manifest = CatalogApprovalManifestSchema.parse(product.detailSourceManifest);
  const sourceIds = new Set(manifest.variantIds);
  const plan = planCatalogDetailApproval({ product, variants, revision: 'review-candidate' });
  if (
    product.detailSourceRevision !== manifest.revision ||
    manifest.variantIds.length !== variants.length ||
    variants.some(
      (row) => !sourceIds.has(row._id) || row.detailSourceRevision !== manifest.revision,
    )
  )
    throw new Error('Incomplete or mixed source generation');
  return hash({
    manifest: { revision: manifest.revision, variantIds: [...manifest.variantIds].sort() },
    owner: product.detailSourceOwner,
    published: product.published ?? null,
    productFamily: product.productFamily ?? null,
    category: product.category ?? null,
    pricingPolicy: {
      mode: product.catalogPricingMode ?? null,
      manual: product.manualCatalogPricing ?? null,
      unitPrice: product.unitPrice ?? null,
      wholesalePrice: product.wholesalePrice ?? null,
      moq: product.moq ?? null,
      sourceKey: product.alibabaPrimarySourceKey ?? null,
      sourcePricing: product.alibabaCatalogPricing ?? null,
    },
    plan,
  });
}

/** Execute only inside an adapter's atomic transaction. No external effects or transaction nesting. */
export async function commitCatalogApproval(
  tx: CatalogApprovalTransaction,
  actorId: string,
  input: unknown,
): Promise<CatalogApprovalResult> {
  const parsed = CatalogApprovalCommandSchema.safeParse(input);
  if (!parsed.success || !identity.safeParse(actorId).success)
    return { ok: false, code: 'VALIDATION_ERROR' };
  const command = parsed.data;
  const actor = await tx.get('users', actorId);
  if (!actor || actor.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  const product = await tx.get('products', command.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const previous =
    product.catalogDetailPublication == null
      ? null
      : CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (previous && (!previous.success || previous.data.header._id !== product._id))
    return { ok: false, code: 'CONFLICT' };
  const previousRevision = previous?.success ? previous.data.revision : null;
  const requestDigest = hash({ actorId, command });
  const receipt = z
    .object({
      operationId: z.string().uuid(),
      revision: z.string().uuid(),
      requestDigest: z.string(),
      variantCount: z.number().int().nonnegative(),
    })
    .safeParse(product.catalogDetailApprovalReceipt);
  if (receipt.success && receipt.data.operationId === command.operationId) {
    if (
      receipt.data.requestDigest !== requestDigest ||
      previousRevision !== receipt.data.revision ||
      !previous?.success ||
      previous.data.variantCount !== receipt.data.variantCount
    )
      return { ok: false, code: 'CONFLICT' };
    return {
      ok: true,
      productId: product._id,
      revision: receipt.data.revision,
      variants: receipt.data.variantCount,
      replayed: true,
    };
  }
  if (previousRevision !== command.expectedRevision) return { ok: false, code: 'CONFLICT' };
  const manifest = CatalogApprovalManifestSchema.safeParse(product.detailSourceManifest);
  if (
    !manifest.success ||
    product.detailSourceReady !== true ||
    product.detailSourceRevision !== manifest.data.revision
  )
    return { ok: false, code: 'SOURCE_NOT_READY' };
  // CloudBase: <=100 operations per transaction. Reserve two for begin/commit.
  // actor get + product get/set + each SKU get/set + each image get/set.
  const gallery = z
    .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
    .max(9)
    .safeParse(product.imageIds);
  if (!gallery.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const descriptionGallery = z
    .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
    .max(18)
    .optional()
    .safeParse(product.descriptionImageIds);
  if (!descriptionGallery.success) return { ok: false, code: 'VALIDATION_ERROR' };
  if (
    3 +
      2 * manifest.data.variantIds.length +
      2 * new Set([...gallery.data, ...(descriptionGallery.data ?? [])]).size >
    98
  )
    return { ok: false, code: 'APPROVAL_TOO_LARGE' };
  const rows: CollectionDoc[] = [];
  for (const id of manifest.data.variantIds) {
    const row = await tx.get('productVariants', id);
    if (!row || row.detailSourceRevision !== manifest.data.revision)
      return { ok: false, code: 'SOURCE_NOT_READY' };
    rows.push(row);
  }
  let plan: ReturnType<typeof planCatalogDetailApproval>;
  // Revision is server-generated, not the caller's retry key: a reused key can never resurrect a historical revision.
  const revision = randomUUID();
  try {
    plan = planCatalogDetailApproval({ product, variants: rows, revision });
    if (catalogApprovalDigest(product, rows) !== command.expectedDigest)
      return { ok: false, code: 'CONFLICT' };
  } catch {
    return { ok: false, code: 'VALIDATION_ERROR' };
  }
  const images: CollectionDoc[] = [];
  if (
    rows.some(
      (row) =>
        Array.isArray(row.detailSourceUnboundMediaSources) &&
        row.detailSourceUnboundMediaSources.length > 0,
    )
  )
    return { ok: false, code: 'MEDIA_NOT_READY' };
  const beforeImages = new Set(catalogReferencedImageIds(product));
  const afterImages = new Set(
    catalogReferencedImageIds({ ...product, catalogDetailPublication: plan.publication }),
  );
  const imageIds = new Set([...beforeImages, ...afterImages]);
  if (3 + 2 * rows.length + 2 * imageIds.size > 98)
    return { ok: false, code: 'APPROVAL_TOO_LARGE' };
  for (const id of imageIds) {
    const image = await tx.get('images', id);
    if (
      !image ||
      image.status !== 'active' ||
      readImageMutationState(image).state !== 'free' ||
      (image.storageProvider !== 'cloudbase-storage' && image.storageProvider !== 'local-disk') ||
      (Object.hasOwn(image, 'publishedRefCount') &&
        (typeof image.publishedRefCount !== 'number' ||
          !Number.isSafeInteger(image.publishedRefCount) ||
          image.publishedRefCount < 0))
    )
      return { ok: false, code: 'MEDIA_NOT_READY' };
    images.push(image);
  }
  const referenceDelta = (id: string) =>
    product.published === true ? Number(afterImages.has(id)) - Number(beforeImages.has(id)) : 0;
  if (images.some((image) => Number(image.publishedRefCount ?? 0) + referenceDelta(image._id) < 0))
    return { ok: false, code: 'MEDIA_NOT_READY' };
  // Every deterministic rejection is above this boundary. Exceptions below MUST abort the transaction.
  // Unchanged media writes include lifecycle rows in conflict detection; reading alone is snapshot isolation.
  for (const image of images)
    await tx.set('images', {
      ...image,
      ...(referenceDelta(image._id)
        ? { publishedRefCount: Number(image.publishedRefCount ?? 0) + referenceDelta(image._id) }
        : {}),
      catalogDetailApprovalFence: revision,
    });
  const byId = new Map(rows.map((row) => [row._id, row]));
  for (const [position, variant] of plan.variants.entries()) {
    const row = byId.get(variant.id);
    if (!row) throw new Error('Approval plan changed identity');
    await tx.set('productVariants', {
      ...row,
      catalogDetailApproved: variant,
      catalogDetailRevision: revision,
      catalogDetailPosition: position,
    });
  }
  await tx.set('products', {
    ...product,
    catalogDetailPublication: plan.publication,
    catalogDetailApprovalReceipt: {
      operationId: command.operationId,
      revision,
      requestDigest,
      actorId,
      variantCount: plan.variants.length,
      approvedAt: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    productId: product._id,
    revision,
    variants: plan.variants.length,
    replayed: false,
  };
}

function document(value: unknown): CollectionDoc | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (row == null) return null;
  if (
    typeof row !== 'object' ||
    Array.isArray(row) ||
    !('_id' in row) ||
    typeof row._id !== 'string'
  )
    throw new Error('Malformed CloudBase document');
  return row as CollectionDoc;
}

export async function approveCatalogDetailInCloud(
  db: NodeSdkDatabase,
  actorId: string,
  input: unknown,
): Promise<CatalogApprovalResult> {
  return db.runTransaction((tx) =>
    commitCatalogApproval(
      {
        get: async (collection, id) =>
          document((await tx.collection(collection).doc(id).get()).data),
        set: async (collection, row) => {
          const { _id, ...data } = row;
          const result = await tx.collection(collection).doc(_id).set(data);
          if (result.updated !== 1) throw new Error('Approval write not confirmed');
        },
      },
      actorId,
      input,
    ),
  );
}
