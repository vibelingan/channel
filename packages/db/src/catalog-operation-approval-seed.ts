/** A server-read candidate joins the original saved operation, never a second approval job. */
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import {
  CatalogValidationError,
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { CatalogProductOperationBindingSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import { type ApprovalStageResult, prepareStagedApproval } from './catalog-detail-staging.ts';
import {
  type CatalogApprovalStore,
  readCatalogApprovalCandidate,
} from './catalog-detail-workflow.ts';

export async function prepareOwnedApprovalSeed(
  store: CatalogApprovalStore,
  actorId: string,
  input: unknown,
  canBegin: () => boolean = () => true,
): Promise<ApprovalStageResult> {
  if (!fitsJsonBudget(input, 4096, 12)) return { ok: false, code: 'VALIDATION_ERROR' };
  const parsed = CatalogProductOperationBindingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const scope = parsed.data;
  const owned = await store.persist(actorId, {
    action: 'operation-get',
    productId: scope.productId,
    operationId: scope.operationId,
  });
  if (!owned.ok) return owned;
  if (
    !('record' in owned) ||
    owned.record.actorId !== actorId ||
    owned.record.productId !== scope.productId ||
    owned.record.operationId !== scope.operationId ||
    owned.record.operation.inputDigest !== scope.inputDigest ||
    owned.record.operation.intent !== 'publish' ||
    Object.hasOwn(owned.record.operation, 'cancelledAt')
  )
    return { ok: false, code: 'CONFLICT' };
  if (owned.record.state === 'complete') return owned;
  if (!owned.current || !owned.revisionCurrent || owned.expired)
    return { ok: false, code: 'CONFLICT' };
  if (owned.record.state === 'staging') return owned;
  if (owned.record.state !== 'saved') return { ok: false, code: 'CONFLICT' };
  if (!canBegin()) return owned;
  const candidate = await readCatalogApprovalCandidate(store, scope.productId, canBegin);
  if (!canBegin()) return owned;
  if (!candidate.ok) return candidate;
  let digest: string;
  let revision: string | null;
  try {
    const current =
      candidate.product.catalogDetailPublication == null
        ? null
        : CatalogDetailPublicationSchema.parse(candidate.product.catalogDetailPublication);
    if (current && current.header._id !== scope.productId) return { ok: false, code: 'CONFLICT' };
    revision = current?.revision ?? null;
    digest = catalogApprovalDigest(candidate.product, candidate.rows);
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('begin', error.issues);
    if (error instanceof z.ZodError)
      return catalogValidationFailure(
        'begin',
        catalogIssuesFromZod(error.issues, candidate.product, {
          stage: 'commit',
          remedy: 'system-repair',
        }),
      );
    throw error;
  }
  const prepared = prepareStagedApproval(
    actorId,
    {
      productId: scope.productId,
      operationId: scope.operationId,
      expectedRevision: revision,
      expectedDigest: digest,
    },
    candidate.product,
    candidate.rows,
  );
  if (!prepared.ok) return prepared;
  if (!canBegin()) return owned;
  return store.persist(actorId, {
    ...scope,
    action: 'operation-approval-begin',
    prepared: prepared.value,
  });
}
