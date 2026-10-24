/** Shared legacy/owned immutable page plan; all reads finish before any write. */
import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import {
  CatalogValidationError,
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import {
  APPROVAL_PAGE_SIZE,
  type ApprovalFailure,
  type PreparedApproval,
} from './catalog-approval-job.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: ApprovalFailure['code']): ApprovalFailure => ({ ok: false, code });
export type ApprovalPagePlan = { ok: true; documents: CollectionDoc[]; nextPage: number };
export function isApprovalPage(job: PreparedApproval, page: number): boolean {
  return (
    Number.isSafeInteger(page) && page >= 0 && page < job.pageHashes.length && page <= job.nextPage
  );
}
export async function prepareApprovalPage(
  tx: CatalogApprovalTransaction,
  product: CollectionDoc,
  job: PreparedApproval,
  page: number,
): Promise<ApprovalPagePlan | ApprovalFailure> {
  const offset = page * APPROVAL_PAGE_SIZE;
  const rows: CollectionDoc[] = [];
  for (const variantId of job.variantIds.slice(offset, offset + APPROVAL_PAGE_SIZE)) {
    const row = await tx.get('productVariants', variantId);
    if (!row || row.detailSourceRevision !== product.detailSourceRevision)
      return fail('SOURCE_NOT_READY');
    rows.push(row);
  }
  let variants: ReturnType<typeof planCatalogDetailApproval>['variants'];
  try {
    variants = planCatalogDetailApproval({
      product,
      variants: rows,
      revision: job.revision,
    }).variants;
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('page', error.issues);
    if (error instanceof z.ZodError)
      return catalogValidationFailure(
        'page',
        catalogIssuesFromZod(error.issues, rows, {
          stage: 'effective-content',
          remedy: 'edit',
          prefix: ['variants', 'items'],
        }),
      );
    return fail('VALIDATION_ERROR');
  }
  if (hash(variants) !== job.pageHashes[page]) return fail('CONFLICT');
  const documents = variants.map((variant, position) => ({
    _id: approvedVariantDocumentId(job.productId, job.revision, variant.id),
    productId: job.productId,
    variantId: variant.id,
    catalogDetailRevision: job.revision,
    catalogDetailPosition: offset + position,
    catalogDetailApproved: variant,
  }));

  return { ok: true, documents, nextPage: page + 1 };
}
export async function storeApprovalPage(
  tx: CatalogApprovalTransaction,
  plan: ApprovalPagePlan,
  root: CollectionDoc,
): Promise<void> {
  for (const document of plan.documents) await tx.set('catalogDetailVariants', document);
  await tx.set('catalogDetailApprovals', root);
}
