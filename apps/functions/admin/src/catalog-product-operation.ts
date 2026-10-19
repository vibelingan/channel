import {
  type CatalogProductSaveInput,
  type CatalogProductSaveResult,
  get,
  manageCatalogProductOperation,
} from '@vibelingan-channel/db';
import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import {
  type OwnedFinalContinuationStep,
  continueOwnedCatalogPublication,
} from './catalog-operation-final-continue.ts';
import { createOwnedMediaPreparation } from './catalog-operation-media-preparation.ts';
import { continueOwnedCatalogReferences } from './catalog-operation-reference-continue.ts';
import type { CatalogPreparationInvoker } from './catalog-preparation-invoker.ts';
import { continueAdminCatalogProductOperation } from './catalog-product-operation-continue.ts';
import { withAdminEditsKept } from './catalog-supplier-review.ts';

/** Freeze the same supplier keep choices as the existing Admin edit flow. */
export function manageAdminCatalogProductOperation(
  actorId: string,
  input: unknown,
  preparation?: {
    authority?: CatalogPreparationAuthority;
    invoke?: CatalogPreparationInvoker;
    publish?: OwnedFinalContinuationStep;
    save?: (input: CatalogProductSaveInput) => Promise<CatalogProductSaveResult>;
  },
) {
  if (
    input &&
    typeof input === 'object' &&
    Reflect.get(input, 'action') === 'product-operation-continue'
  )
    return continueAdminCatalogProductOperation(
      actorId,
      input,
      undefined,
      undefined,
      preparation?.authority && preparation.invoke
        ? createOwnedMediaPreparation(preparation.authority, preparation.invoke)
        : undefined,
      continueOwnedCatalogReferences,
      preparation?.publish ?? continueOwnedCatalogPublication,
      preparation?.save,
    );
  const productId =
    input && typeof input === 'object' ? Reflect.get(input, 'productId') : undefined;
  return manageCatalogProductOperation(
    actorId,
    input,
    async (values) => {
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
    },
    preparation?.save,
  );
}
