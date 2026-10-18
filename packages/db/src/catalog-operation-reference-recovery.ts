/** Bounded recovery on the real private reference-page entry; cancellation eligibility remains transactional. */
import { performance } from 'node:perf_hooks';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { ApprovalStageResult } from './catalog-detail-staging.ts';
import type { CatalogApprovalStore } from './catalog-detail-workflow.ts';
import { CATALOG_IMAGE_REFERENCE_LEDGER_FIELD } from './catalog-image-reference-store.ts';
import {
  CATALOG_IMAGE_REFERENCE_MAX_PENDING,
  CatalogImageReferenceError,
  catalogImageReferencePendingEntries,
} from './catalog-image-references.ts';
import {
  CatalogOwnedApprovalReferencesSchema,
  readOwnedApprovalReferencePlan,
} from './catalog-operation-references.ts';
import {
  PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES,
  ProductOperationRecoverSchema,
  ProductOperationReferencePageSchema,
} from './catalog-product-operation.ts';
export const REFERENCE_RECOVERY_MAX_CANDIDATES = 3;
export const REFERENCE_RECOVERY_BUDGET_MS = 12000;
export const ReferenceRecoveryCursorSchema = z
  .object({
    imageId: z.string().min(1).max(200),
    ledgerDigest: z.string().regex(/^[a-f0-9]{64}$/),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .max(CATALOG_IMAGE_REFERENCE_MAX_PENDING - 1),
  })
  .strict();
export type ReferenceRecoveryCursor = z.infer<typeof ReferenceRecoveryCursorSchema>;
export type ReferenceRecoveryPageResult =
  | ApprovalStageResult
  | { ok: false; code: 'MEDIA_BUSY'; referenceRecovery: ReferenceRecoveryCursor };
const fail = (code: 'VALIDATION_ERROR' | 'CONFLICT' | 'MEDIA_NOT_READY') => ({
  ok: false as const,
  code,
});
export async function persistOwnedReferencePageWithRecovery(
  store: CatalogApprovalStore,
  actorId: string,
  input: unknown,
  cursor?: unknown,
  now: () => number = () => performance.now(),
): Promise<ReferenceRecoveryPageResult> {
  const parsed = ProductOperationReferencePageSchema.safeParse(input);
  if (!parsed.success || !fitsJsonBudget(input, 4096, 8)) return fail('VALIDATION_ERROR');
  const command = parsed.data;
  const continuation =
    cursor === undefined ? undefined : ReferenceRecoveryCursorSchema.safeParse(cursor);
  if (continuation && (!continuation.success || !fitsJsonBudget(cursor, 1024, 8)))
    return fail('VALIDATION_ERROR');
  const deadline = now() + REFERENCE_RECOVERY_BUDGET_MS;
  const first = await store.persist(actorId, command);
  if (
    first.ok ||
    first.code !== 'MEDIA_BUSY' ||
    !('pendingReferenceImageId' in first) ||
    typeof first.pendingReferenceImageId !== 'string' ||
    now() >= deadline
  )
    return first;
  const imageId = first.pendingReferenceImageId;
  const own = await store.persist(actorId, {
    action: 'operation-get',
    productId: command.productId,
    operationId: command.operationId,
  });
  if (!own.ok) return own;
  if (
    !('record' in own) ||
    own.record.actorId !== actorId ||
    own.record.productId !== command.productId ||
    own.record.operationId !== command.operationId ||
    own.record.operation.inputDigest !== command.inputDigest
  )
    return fail('CONFLICT');
  if (own.record.state === 'complete') return own;
  if (
    !own.current ||
    !own.revisionCurrent ||
    own.expired ||
    own.record.state !== 'staging' ||
    !own.record.references
  )
    return fail('CONFLICT');
  const progress = own.record.referenceStage?.cursor ?? 0;
  if (progress > command.cursor) return own;
  const plan = readOwnedApprovalReferencePlan(own.record, own.record.references);
  if (
    progress !== command.cursor ||
    !plan ||
    !plan.changes
      .slice(command.cursor, command.cursor + 20)
      .some((change) => change.imageId === imageId)
  )
    return fail('CONFLICT');
  if (now() >= deadline) return first;
  const image = await store.get('images', imageId);
  if (
    !image ||
    image._id !== imageId ||
    !Object.hasOwn(image, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD) ||
    !Object.hasOwn(image, 'publishedRefCount') ||
    image[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD] === undefined ||
    !z.number().int().nonnegative().safe().safeParse(image.publishedRefCount).success
  )
    return fail('MEDIA_NOT_READY');
  let members: ReturnType<typeof catalogImageReferencePendingEntries>;
  try {
    members = catalogImageReferencePendingEntries(
      imageId,
      image[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD],
    );
  } catch (error) {
    if (error instanceof CatalogImageReferenceError) return fail('MEDIA_NOT_READY');
    throw error;
  }
  if (now() >= deadline) return first;
  if (members.length < CATALOG_IMAGE_REFERENCE_MAX_PENDING) return store.persist(actorId, command);
  const ledgerDigest = alibabaPricingFingerprint([
    imageId,
    image[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD],
  ]);
  const old = continuation?.success ? continuation.data : undefined;
  const offset = old?.imageId === imageId && old.ledgerDigest === ledgerDigest ? old.nextOffset : 0;
  const waiting = (nextOffset: number): ReferenceRecoveryPageResult => ({
    ok: false,
    code: 'MEDIA_BUSY',
    referenceRecovery: {
      imageId,
      ledgerDigest,
      nextOffset: nextOffset >= members.length ? 0 : nextOffset,
    },
  });
  const end = Math.min(members.length, offset + REFERENCE_RECOVERY_MAX_CANDIDATES);
  for (let index = offset; index < end; index++) {
    if (now() >= deadline) return waiting(index);
    const member = members[index];
    if (!member) return fail('CONFLICT');
    const root = await store.get('catalogDetailApprovals', member.operationRootId);
    if (
      !root ||
      root._id !== member.operationRootId ||
      !fitsJsonBudget(root, PRODUCT_OPERATION_APPROVAL_RECORD_MAX_BYTES, 32)
    )
      continue;
    const references = CatalogOwnedApprovalReferencesSchema.safeParse(root.references);
    const operation = z
      .object({ inputDigest: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(root.operation);
    if (
      !references.success ||
      references.data.operationRootId !== member.operationRootId ||
      references.data.treeRoot !== member.treeRoot ||
      references.data.leafCount !== member.leafCount ||
      !operation.success
    )
      continue;
    const request = ProductOperationRecoverSchema.safeParse({
      action: 'operation-recover',
      productId: root.productId,
      operationId: root.operationId,
      operationRootId: root._id,
      inputDigest: operation.data.inputDigest,
    });
    if (!request.success) continue;
    if (now() >= deadline) return waiting(index);
    const recovered = await store.persist(actorId, request.data);
    if (!recovered.ok) {
      if (recovered.code === 'CONFLICT' || recovered.code === 'NOT_FOUND') continue;
      return recovered;
    }
    if (
      'recovery' in recovered &&
      ['cancelled', 'already-cancelled', 'already-complete'].includes(recovered.recovery ?? '')
    ) {
      if (now() >= deadline) return waiting(index + 1);
      return store.persist(actorId, command);
    }
  }
  return waiting(end);
}
