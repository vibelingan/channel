/** Plans pending image deltas; callers must read the image and proofs in one transaction snapshot. */
import { createHash } from 'node:crypto';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { z } from 'zod';

export const CATALOG_IMAGE_REFERENCE_MAX_PENDING = 80;
export const CATALOG_IMAGE_REFERENCE_MAX_LEAVES = 65536;
export const CATALOG_IMAGE_REFERENCE_LEDGER_MAX_BYTES = 128 * 1024;
const MAX_DEPTH = 16;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const integer = z.number().int().nonnegative().safe();
const CommitmentSchema = z.object({
  operationRootId: digest,
  treeRoot: digest,
  leafCount: integer.max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
});
const PendingSchema = CommitmentSchema.extend({
  leafCount: integer.min(1).max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES),
  index: integer.max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES - 1),
  delta: z.union([z.literal(-1), z.literal(1)]),
  siblings: z.array(digest).max(MAX_DEPTH),
}).strict();
const CommitProofSchema = CommitmentSchema.extend({
  _id: digest,
  kind: z.literal('catalog-image-reference-commit-v1'),
}).strict();
const CancelProofSchema = CommitProofSchema.extend({
  kind: z.literal('catalog-image-reference-cancel-v1'),
}).strict();
const ProofSchema = z.discriminatedUnion('kind', [CommitProofSchema, CancelProofSchema]);
const LedgerSchema = z
  .object({
    version: z.literal('catalog-image-reference-ledger-v1'),
    epoch: integer,
    pending: z.array(PendingSchema).max(CATALOG_IMAGE_REFERENCE_MAX_PENDING),
  })
  .strict();
export type CatalogImageReferenceCommitment = z.infer<typeof CommitmentSchema>;
export type CatalogImageReferencePending = z.infer<typeof PendingSchema>;
export type CatalogImageReferenceProof = z.infer<typeof ProofSchema>;
export type CatalogImageReferenceLedger = z.infer<typeof LedgerSchema>;
type ReferenceChange = { imageId: string; delta: -1 | 1 };
export interface CatalogImageReferencePlan {
  readonly proof: z.infer<typeof CommitProofSchema>;
  readonly changes: readonly ReferenceChange[];
  readonly levels: readonly (readonly string[])[];
}
type ErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_LEDGER'
  | 'INVALID_PROOF'
  | 'INVALID_COUNT'
  | 'MISSING_SNAPSHOT_READ'
  | 'DOCUMENT_BUDGET_EXCEEDED';
export class CatalogImageReferenceError extends Error {
  constructor(readonly code: ErrorCode) {
    super(`Image reference check failed: ${code}`);
    this.name = 'CatalogImageReferenceError';
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const leafHash = (id: string, delta: -1 | 1) =>
  hash(['catalog-image-reference-leaf-v1', id, delta]);
const nodeHash = (left: string, right: string) =>
  hash(['catalog-image-reference-node-v1', left, right]);

/** Inputs are the before/after PUBLIC reference sets, not draft-only image holds. */
export function buildCatalogImageReferencePlan(
  operationRootId: string,
  before: readonly string[],
  after: readonly string[],
): CatalogImageReferencePlan {
  const ids = z.array(imageId).max(CATALOG_IMAGE_REFERENCE_MAX_LEAVES);
  const oldIds = ids.safeParse(before);
  const newIds = ids.safeParse(after);
  if (!digest.safeParse(operationRootId).success || !oldIds.success || !newIds.success)
    throw new CatalogImageReferenceError('INVALID_PLAN');
  const oldSet = new Set(oldIds.data);
  const newSet = new Set(newIds.data);
  const changes: ReferenceChange[] = [];
  for (const id of oldSet) if (!newSet.has(id)) changes.push({ imageId: id, delta: -1 });
  for (const id of newSet) if (!oldSet.has(id)) changes.push({ imageId: id, delta: 1 });
  if (changes.length > CATALOG_IMAGE_REFERENCE_MAX_LEAVES)
    throw new CatalogImageReferenceError('INVALID_PLAN');
  changes.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
  const levels: string[][] = [
    changes.length
      ? changes.map((change) => leafHash(change.imageId, change.delta))
      : [hash(['catalog-image-reference-empty-v1'])],
  ];
  let level = levels[0];
  if (!level) throw new CatalogImageReferenceError('INVALID_PLAN');
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      if (!left) throw new CatalogImageReferenceError('INVALID_PLAN');
      next.push(nodeHash(left, level[i + 1] ?? left));
    }
    levels.push(next);
    level = next;
  }
  const treeRoot = level[0];
  if (!treeRoot) throw new CatalogImageReferenceError('INVALID_PLAN');
  const commitment = { operationRootId, treeRoot, leafCount: changes.length };
  return {
    proof: {
      ...commitment,
      _id: catalogImageReferenceProofId(commitment),
      kind: 'catalog-image-reference-commit-v1',
    },
    changes,
    levels,
  };
}

/** Generate only the current page's paths rather than expanding every image into every sibling hash. */
export function catalogImageReferenceEntry(
  plan: CatalogImageReferencePlan,
  index: number,
): CatalogImageReferencePending {
  const change = plan.changes[index];
  if (!Number.isSafeInteger(index) || index < 0 || !change)
    throw new CatalogImageReferenceError('INVALID_PLAN');
  let position = index;
  const siblings: string[] = [];
  for (const level of plan.levels.slice(0, -1)) {
    const sibling = level[position % 2 === 0 ? position + 1 : position - 1] ?? level[position];
    if (!sibling) throw new CatalogImageReferenceError('INVALID_PLAN');
    siblings.push(sibling);
    position = Math.floor(position / 2);
  }
  return {
    operationRootId: plan.proof.operationRootId,
    treeRoot: plan.proof.treeRoot,
    leafCount: plan.proof.leafCount,
    index,
    delta: change.delta,
    siblings,
  };
}

export function catalogImageReferenceProofId(commitment: CatalogImageReferenceCommitment): string {
  const parsed = CommitmentSchema.safeParse(commitment);
  if (!parsed.success) throw new CatalogImageReferenceError('INVALID_PLAN');
  return hash([
    'catalog-image-reference-proof-v1',
    parsed.data.operationRootId,
    parsed.data.treeRoot,
    parsed.data.leafCount,
  ]);
}

/** The same immutable terminal slot can record cancellation of an uncommitted plan. */
export function catalogImageReferenceCancelProof(
  input: CatalogImageReferenceCommitment,
): z.infer<typeof CancelProofSchema> {
  const parsed = CommitmentSchema.safeParse(input);
  if (!parsed.success) throw new CatalogImageReferenceError('INVALID_PLAN');
  return {
    ...parsed.data,
    _id: catalogImageReferenceProofId(parsed.data),
    kind: 'catalog-image-reference-cancel-v1',
  };
}

/** Missing map keys mean a missing database read; null means this snapshot read a missing proof. */
export function planImageReferenceSettlement(
  id: string,
  publishedRefCount: unknown,
  inputLedger: unknown,
  proofs: ReadonlyMap<string, unknown>,
): {
  effectiveCount: number;
  resolvedProofIds: string[];
  settlement: { publishedRefCount: number; ledger: CatalogImageReferenceLedger } | null;
} {
  if (!integer.safeParse(publishedRefCount).success || typeof publishedRefCount !== 'number')
    throw new CatalogImageReferenceError('INVALID_COUNT');
  const current = readReferenceLedger(id, inputLedger);
  if (!current)
    return { effectiveCount: publishedRefCount, resolvedProofIds: [], settlement: null };
  const resolvedProofIds: string[] = [];
  const pending: CatalogImageReferencePending[] = [];
  let sum = 0;
  for (const item of current.pending) {
    const proofId = catalogImageReferenceProofId(item);
    if (!proofs.has(proofId)) throw new CatalogImageReferenceError('MISSING_SNAPSHOT_READ');
    const row = proofs.get(proofId);
    if (row === null) {
      pending.push(item);
      continue;
    }
    const proof = ProofSchema.safeParse(row);
    if (
      !proof.success ||
      proof.data._id !== proofId ||
      proof.data.operationRootId !== item.operationRootId ||
      proof.data.treeRoot !== item.treeRoot ||
      proof.data.leafCount !== item.leafCount
    )
      throw new CatalogImageReferenceError('INVALID_PROOF');
    if (proof.data.kind === 'catalog-image-reference-commit-v1') sum += item.delta;
    resolvedProofIds.push(proofId);
  }
  // Sum small signed deltas first, so a valid net-zero change at MAX_SAFE_INTEGER does not overflow.
  const effectiveCount = publishedRefCount + sum;
  if (!integer.safeParse(effectiveCount).success)
    throw new CatalogImageReferenceError('INVALID_COUNT');
  if (resolvedProofIds.length === 0) return { effectiveCount, resolvedProofIds, settlement: null };
  if (!Number.isSafeInteger(current.epoch + 1))
    throw new CatalogImageReferenceError('INVALID_LEDGER');
  return {
    effectiveCount,
    resolvedProofIds,
    settlement: {
      publishedRefCount: effectiveCount,
      ledger: { ...current, epoch: current.epoch + 1, pending },
    },
  };
}

/** Validate the entire bounded ledger before a caller starts its proof reads. */
export function catalogImageReferenceProofIds(id: string, inputLedger: unknown): string[] {
  return readReferenceLedger(id, inputLedger)?.pending.map(catalogImageReferenceProofId) ?? [];
}
function readReferenceLedger(id: string, inputLedger: unknown): CatalogImageReferenceLedger | null {
  if (!imageId.safeParse(id).success) throw new CatalogImageReferenceError('INVALID_LEDGER');
  if (inputLedger === undefined) return null;
  if (!fitsJsonBudget(inputLedger, CATALOG_IMAGE_REFERENCE_LEDGER_MAX_BYTES))
    throw new CatalogImageReferenceError('INVALID_LEDGER');
  const parsed = LedgerSchema.safeParse(inputLedger);
  if (!parsed.success) throw new CatalogImageReferenceError('INVALID_LEDGER');
  const roots = new Set<string>();
  for (const item of parsed.data.pending) {
    if (roots.has(item.operationRootId)) throw new CatalogImageReferenceError('INVALID_LEDGER');
    roots.add(item.operationRootId);
    verifyMembership(id, item);
  }
  return parsed.data;
}

function verifyMembership(id: string, pending: CatalogImageReferencePending): void {
  if (
    pending.index >= pending.leafCount ||
    pending.siblings.length !== Math.ceil(Math.log2(pending.leafCount))
  )
    throw new CatalogImageReferenceError('INVALID_LEDGER');
  let width = pending.leafCount;
  let index = pending.index;
  let value = leafHash(id, pending.delta);
  for (const sibling of pending.siblings) {
    if (index % 2 === 0 && index + 1 === width && sibling !== value)
      throw new CatalogImageReferenceError('INVALID_LEDGER');
    value = index % 2 === 0 ? nodeHash(value, sibling) : nodeHash(sibling, value);
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  if (value !== pending.treeRoot) throw new CatalogImageReferenceError('INVALID_LEDGER');
}
