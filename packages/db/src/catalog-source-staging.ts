/** Bounded server-only source preparation. No provider calls and no publication writes. */
import { createHash } from 'node:crypto';
import {
  CatalogContentSchema,
  CatalogDetailHeaderSchema,
  CatalogDetailVariantSchema,
  CatalogNoteBlocksSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';

const id = z.string().trim().min(1).max(200);
export const sourceDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const SourcePageSchema = z
  .object({
    action: z.literal('source-page'),
    productId: id,
    sourceKey: id,
    observationId: id,
    observationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    galleryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    header: CatalogDetailHeaderSchema,
    content: CatalogContentSchema.nullable(),
    noteBlocks: CatalogNoteBlocksSchema.nullable(),
    variantIds: z
      .array(id)
      .max(10000)
      .refine((ids) => new Set(ids).size === ids.length),
    page: z.number().int().min(0).max(499),
    variants: z.array(CatalogDetailVariantSchema).max(20),
  })
  .strict();

export async function stageSourcePage(
  tx: CatalogApprovalTransaction,
  actorId: string,
  input: z.infer<typeof SourcePageSchema>,
) {
  const fail = (code: 'FORBIDDEN' | 'CONFLICT' | 'SOURCE_NOT_READY' | 'VALIDATION_ERROR') => ({
    ok: false as const,
    code,
  });
  const actor = await tx.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended') return fail('FORBIDDEN');
  const product = await tx.get('products', input.productId);
  const observed = await tx.get('catalogSourceObservations', input.observationId);
  if (
    !product ||
    product.alibabaPrimarySourceKey !== input.sourceKey ||
    product.archived === true ||
    !observed ||
    sourceDigest(observed.observation) !== input.observationDigest ||
    sourceDigest(product.imageIds ?? []) !== input.galleryDigest
  )
    return fail('CONFLICT');
  if (input.header._id !== product._id) return fail('VALIDATION_ERROR');
  const pages = Math.max(1, Math.ceil(input.variantIds.length / 20));
  const expected = input.variantIds.slice(input.page * 20, (input.page + 1) * 20);
  if (
    input.page >= pages ||
    JSON.stringify(expected) !== JSON.stringify(input.variants.map((v) => v.id))
  )
    return fail('VALIDATION_ERROR');
  const same = product.detailSourceRevision === input.revision;
  const cursor =
    same && typeof product.detailSourceNextPage === 'number' ? product.detailSourceNextPage : 0;
  const progress = (nextPage: number) => ({
    ok: true as const,
    jobId: input.revision,
    revision: input.revision,
    nextPage,
    pages,
    complete: nextPage === pages,
  });
  if (same && cursor > input.page) return progress(cursor);
  if (input.page !== cursor) return fail('SOURCE_NOT_READY');
  const owner = `alibaba:${input.sourceKey}`;
  const rows = [];
  for (const [offset, variant] of input.variants.entries()) {
    const existing = await tx.get('productVariants', variant.id);
    if (existing && (existing.productId !== product._id || existing.detailSourceOwner !== owner))
      return fail('CONFLICT');
    rows.push({
      ...existing,
      _id: variant.id,
      productId: product._id,
      detailSourceOwner: owner,
      detailSourceRevision: input.revision,
      detailSourceMissing: false,
      archived: false,
      position: input.page * 20 + offset,
      sku: variant.sku ?? '',
      optionValues: Object.fromEntries(variant.options.map((o) => [o.name, o.value])),
      imageIds: variant.images.map((url) => url.slice('/api/images/'.length)),
      detailSourceCandidate: variant,
    });
  }
  for (const row of rows) await tx.set('productVariants', row);
  // Write the observed row too: concurrent sync is a transaction conflict, not a stale seal.
  await tx.set('catalogSourceObservations', {
    ...observed,
    detailPreparationFence: input.revision,
  });
  await tx.set('products', {
    ...product,
    detailSourceOwner: owner,
    detailSourceRevision: input.revision,
    detailSourceManifest: { revision: input.revision, variantIds: input.variantIds },
    detailSourceNextPage: input.page + 1,
    detailSourceReady: input.page + 1 === pages,
    detailSourceCandidate: input.header,
    detailSourceContentCandidate: input.content,
    detailSourceNoteBlocksCandidate: input.noteBlocks,
  });
  return progress(input.page + 1);
}
