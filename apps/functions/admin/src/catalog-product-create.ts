import { createHash } from 'node:crypto';
import { get } from '@vibelingan-channel/db';
import { type ApiResult, type CollectionDoc, err, ok } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { CatalogProductWriteError } from './catalog-product-identities.ts';

const attemptId = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), attemptId, values: z.record(z.unknown()) }).strict(),
  z.object({ action: z.literal('get'), attemptId, inputDigest: digest }).strict(),
]);
const receipt = z
  .object({
    schemaVersion: z.literal('catalog-product-create-v1'),
    actorId: z.string().min(1).max(200),
    attemptId,
    inputDigest: digest,
  })
  .strict();
export type CatalogCreationReceipt = z.infer<typeof receipt>;
export type CatalogCreationBinding = { productId: string; receipt: CatalogCreationReceipt };

/** Product and receipt share the existing atomic create; recovery never writes a second row. */
export async function manageCatalogProductCreate(
  actorId: string,
  input: unknown,
  create: (
    values: Record<string, unknown>,
    binding: CatalogCreationBinding,
  ) => Promise<ApiResult<unknown>>,
  redact: (doc: CollectionDoc) => CollectionDoc,
): Promise<ApiResult<unknown>> {
  if (!fitsJsonBudget(input, 256 * 1024, 28))
    return err('VALIDATION_ERROR', 'The product creation request is too large.');
  const parsed = command.safeParse(input);
  if (!parsed.success) return err('VALIDATION_ERROR', 'Check the product creation request.');
  const value = parsed.data;
  if (
    value.action === 'start' &&
    ((value.values.published !== undefined && value.values.published !== false) ||
      Object.hasOwn(value.values, 'catalogCreateReceipt'))
  )
    return err('VALIDATION_ERROR', 'Create a draft first, then review it before publishing.');
  const inputDigest =
    value.action === 'get'
      ? value.inputDigest
      : createHash('sha256').update(JSON.stringify(value.values)).digest('hex');
  const productId = createHash('sha256')
    .update(JSON.stringify(['catalog-product-create-v1', actorId, value.attemptId]))
    .digest('hex');
  const binding: CatalogCreationBinding = {
    productId,
    receipt: {
      schemaVersion: 'catalog-product-create-v1',
      actorId,
      attemptId: value.attemptId,
      inputDigest,
    },
  };
  const read = async () => {
    const product = await get('products', productId);
    if (!product)
      return err(
        'NOT_FOUND',
        'This creation has not been confirmed. Check the same attempt again.',
      );
    const saved = receipt.safeParse(product.catalogCreateReceipt);
    if (
      !saved.success ||
      saved.data.actorId !== actorId ||
      saved.data.attemptId !== value.attemptId ||
      saved.data.inputDigest !== inputDigest
    )
      return err(
        'CONFLICT',
        'This creation is bound to different input. Check the original attempt.',
      );
    return ok({
      schemaVersion: 'catalog-product-create-result-v1',
      attemptId: value.attemptId,
      productId,
      inputDigest,
      product: redact(product),
    });
  };
  const existing = await read();
  if (value.action === 'get' || existing.ok || existing.error.code !== 'NOT_FOUND') return existing;
  let result: ApiResult<unknown>;
  try {
    result = await create(value.values, binding);
  } catch (error) {
    if (error instanceof CatalogProductWriteError && error.code === 'PRODUCT_EXISTS') {
      const raced = await read();
      if (raced.ok) return raced;
    }
    throw error;
  }
  if (!result.ok) {
    // Another request may have committed this same attempt while create waited.
    if (result.error.code === 'CONFLICT') {
      const raced = await read();
      if (raced.ok) return raced;
    }
    return result;
  }
  return read();
}
