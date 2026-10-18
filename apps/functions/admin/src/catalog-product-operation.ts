import { get, manageCatalogProductOperation } from '@vibelingan-channel/db';
import { continueAdminCatalogProductOperation } from './catalog-product-operation-continue.ts';
import { withAdminEditsKept } from './catalog-supplier-review.ts';

/** Freeze the same supplier keep choices as the existing Admin edit flow. */
export function manageAdminCatalogProductOperation(actorId: string, input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    Reflect.get(input, 'action') === 'product-operation-continue'
  )
    return continueAdminCatalogProductOperation(actorId, input);
  const productId =
    input && typeof input === 'object' ? Reflect.get(input, 'productId') : undefined;
  return manageCatalogProductOperation(actorId, input, async (values) => {
    if (typeof productId !== 'string') return { ok: false, code: 'VALIDATION_ERROR' };
    const product = await get('products', productId);
    if (!product) return { ok: false, code: 'NOT_FOUND' };
    return {
      ok: true,
      values:
        product.alibabaReviewPending === true &&
        ['changed', 'removed'].includes(String(product.alibabaReviewReason))
          ? await withAdminEditsKept(product, values)
          : values,
    };
  });
}
