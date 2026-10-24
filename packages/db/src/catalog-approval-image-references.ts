/** Merge reference changes into the existing approval transaction's single image writes. */
import { isDeepStrictEqual } from 'node:util';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  type CatalogImageReferenceStore,
  planCatalogImageReferenceSettlement,
} from './catalog-image-reference-store.ts';
import {
  CatalogImageReferenceError,
  catalogImageReferenceProofIds,
  planImageReferenceSettlement,
} from './catalog-image-references.ts';

type ReferencePlan =
  | { ok: true; images: { image: CollectionDoc; delta: number }[] }
  | { ok: false; code: 'MEDIA_NOT_READY' | 'APPROVAL_TOO_LARGE' };

export async function planApprovalImageReferences(
  tx: CatalogImageReferenceStore,
  images: readonly CollectionDoc[],
  deltaFor: (imageId: string) => number,
  remainingDocumentOperations: number,
): Promise<ReferencePlan> {
  if (!Number.isSafeInteger(remainingDocumentOperations) || remainingDocumentOperations < 0)
    return { ok: false, code: 'APPROVAL_TOO_LARGE' };
  try {
    if (new Set(images.map((image) => image._id)).size !== images.length)
      return { ok: false, code: 'MEDIA_NOT_READY' };
    const checked: {
      image: CollectionDoc;
      delta: number;
      base: number | null;
      proofs: string[];
    }[] = [];
    const noProofs = new Map<string, unknown>();
    let extraReads = 0;
    for (const image of images) {
      const delta = deltaFor(image._id);
      if (!Number.isInteger(delta) || Math.abs(delta) > 1)
        return { ok: false, code: 'MEDIA_NOT_READY' };
      const managed = Object.hasOwn(image, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD);
      const base = Object.hasOwn(image, 'publishedRefCount')
        ? planImageReferenceSettlement(image._id, image.publishedRefCount, undefined, noProofs)
            .effectiveCount
        : null;
      if (
        (base === null && (managed || delta !== 0)) ||
        (managed && image[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD] === undefined)
      )
        return { ok: false, code: 'MEDIA_NOT_READY' };
      const proofs = managed
        ? catalogImageReferenceProofIds(image._id, image[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD])
        : [];
      // An unchanged reference needs no terminal reads or settlement, even on the atomic fence path.
      if (delta !== 0 && proofs.length) extraReads += 1 + proofs.length;
      checked.push({ image, delta, base, proofs });
    }
    if (extraReads > remainingDocumentOperations) return { ok: false, code: 'APPROVAL_TOO_LARGE' };

    const result: { image: CollectionDoc; delta: number }[] = [];
    for (const item of checked) {
      if (item.delta === 0) {
        result.push({ image: item.image, delta: 0 });
        continue;
      }
      let image = item.image;
      let count = item.base;
      if (item.proofs.length) {
        const loaded = await planCatalogImageReferenceSettlement(tx, {
          imageId: image._id,
          maxDocumentOperations: item.proofs.length + 2,
        });
        if (loaded.snapshot.state !== 'counted' || !isDeepStrictEqual(loaded.snapshot.image, image))
          return { ok: false, code: 'MEDIA_NOT_READY' };
        count = loaded.snapshot.effectiveCount;
        image = loaded.settlement ?? loaded.snapshot.image;
      }
      if (count === null) return { ok: false, code: 'MEDIA_NOT_READY' };
      const next = count + item.delta;
      if (!Number.isSafeInteger(next) || next < 0) return { ok: false, code: 'MEDIA_NOT_READY' };
      result.push({ image: { ...image, publishedRefCount: next }, delta: item.delta });
    }
    return { ok: true, images: result };
  } catch (error) {
    if (error instanceof CatalogImageReferenceError || error instanceof z.ZodError)
      return { ok: false, code: 'MEDIA_NOT_READY' };
    throw error;
  }
}
