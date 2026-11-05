import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';

const identity = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.trim() === value &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().nonnegative().safe();
const sequence = counter.min(1);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value;
    } catch {
      return false;
    }
  });

/** Hashes must describe the complete verified public content, never a raw DB row. */
export const CatalogPublicStateSchema = z.discriminatedUnion('visible', [
  z.object({ productId: identity, visible: z.literal(false) }).strict(),
  z
    .object({
      productId: identity,
      visible: z.literal(true),
      semanticHash: digest,
      detailRevision: identity.nullable(),
    })
    .strict(),
]);
export type CatalogPublicState = z.infer<typeof CatalogPublicStateSchema>;

const inputSchema = z
  .object({
    siteOrigin: origin,
    before: CatalogPublicStateSchema,
    after: CatalogPublicStateSchema,
    now: timestamp,
  })
  .strict()
  .refine((input) => input.before.productId === input.after.productId);

export const CatalogPublicHeadSchema = z
  .object({
    _id: digest,
    schemaVersion: z.literal(1),
    siteOrigin: origin,
    productId: identity,
    sequence,
    visible: z.boolean(),
    semanticHash: digest,
    detailRevision: identity.nullable(),
    changedAt: timestamp.nullable(),
    latestEventId: digest,
  })
  .strict();
export type CatalogPublicHead = z.infer<typeof CatalogPublicHeadSchema>;

const lease = z.object({ runId: identity, sequence, until: timestamp }).strict();
export const CatalogSeoTaskSchema = z
  .object({
    _id: digest,
    schemaVersion: z.literal(1),
    siteOrigin: origin,
    productId: identity,
    requestedSequence: sequence,
    acceptedSequence: counter,
    state: z.enum(['pending', 'leased', 'writing', 'accepted', 'needs-readback']),
    attempts: counter,
    lease: lease.nullable(),
  })
  .strict()
  .superRefine((task, ctx) => {
    const active = ['leased', 'writing', 'needs-readback'].includes(task.state);
    if (
      task.acceptedSequence > task.requestedSequence ||
      (task.state === 'accepted') !== (task.acceptedSequence === task.requestedSequence) ||
      active !== (task.lease !== null) ||
      (task.lease &&
        (task.attempts < 1 ||
          task.lease.sequence > task.requestedSequence ||
          task.lease.sequence <= task.acceptedSequence))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent refresh state' });
  });
export type CatalogSeoTask = z.infer<typeof CatalogSeoTaskSchema>;

type ErrorCode =
  | 'INVALID_INPUT'
  | 'CORRUPT_RECORD'
  | 'PUBLIC_HEAD_MISMATCH'
  | 'PUBLIC_SEQUENCE_EXHAUSTED'
  | 'PUBLIC_CLOCK_REGRESSION'
  | 'INVALID_PLAN';

export class CatalogPublicChangeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'CatalogPublicChangeError';
  }
}

export interface CatalogPublicChangeStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: string, row: CollectionDoc): Promise<void>;
}

export type CatalogPublicChangePlan = Readonly<{
  kind: 'unchanged' | 'metadata' | 'changed' | 'initialized';
  productId: string;
  siteOrigin: string;
  sequence: number | null;
}>;
type Write = { collection: 'catalogPublicHeads' | 'catalogSeoTasks'; row: CollectionDoc };
const prepared = new WeakMap<
  CatalogPublicChangePlan,
  { store: CatalogPublicChangeStore; writes: Write[]; attempted: boolean }
>();
const hash = (value: readonly (string | number | boolean)[]) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stateHash(state: CatalogPublicState): string {
  return state.visible
    ? state.semanticHash
    : hash(['catalog-public-content-v1', state.productId, false]);
}

/** Read and validate before the caller starts ANY writes in its existing transaction. */
export async function planCatalogPublicChange(
  store: CatalogPublicChangeStore,
  input: unknown,
): Promise<CatalogPublicChangePlan> {
  const request = inputSchema.safeParse(input);
  if (!request.success) throw new CatalogPublicChangeError('INVALID_INPUT');
  const { siteOrigin, before, after, now } = request.data;
  const productId = after.productId;
  const recordId = catalogPublicRecordId(siteOrigin, productId);
  const headRow = await store.get('catalogPublicHeads', recordId);
  const taskRow = await store.get('catalogSeoTasks', recordId);
  let head: CatalogPublicHead | null = null;
  let task: CatalogSeoTask | null = null;
  if (headRow !== null || taskRow !== null) {
    const parsedHead = CatalogPublicHeadSchema.safeParse(headRow);
    const parsedTask = CatalogSeoTaskSchema.safeParse(taskRow);
    if (!parsedHead.success || !parsedTask.success)
      throw new CatalogPublicChangeError('CORRUPT_RECORD');
    head = parsedHead.data;
    task = parsedTask.data;
    if (
      [head, task].some(
        (row) =>
          row._id !== recordId || row.siteOrigin !== siteOrigin || row.productId !== productId,
      ) ||
      task.requestedSequence !== head.sequence ||
      (!head.visible &&
        (head.detailRevision !== null ||
          head.semanticHash !== stateHash({ productId, visible: false })))
    )
      throw new CatalogPublicChangeError('CORRUPT_RECORD');
    if (head.visible !== before.visible || head.semanticHash !== stateHash(before))
      throw new CatalogPublicChangeError('PUBLIC_HEAD_MISMATCH');
  }

  const changed = before.visible !== after.visible || stateHash(before) !== stateHash(after);
  const writes: Write[] = [];
  let kind: CatalogPublicChangePlan['kind'] = 'unchanged';
  let nextSequence = head?.sequence ?? null;
  if (changed) {
    nextSequence = (head?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(nextSequence))
      throw new CatalogPublicChangeError('PUBLIC_SEQUENCE_EXHAUSTED');
    if (head?.changedAt && Date.parse(now) < Date.parse(head.changedAt))
      throw new CatalogPublicChangeError('PUBLIC_CLOCK_REGRESSION');
    const semanticHash = stateHash(after);
    const nextHead = CatalogPublicHeadSchema.parse({
      _id: recordId,
      schemaVersion: 1,
      siteOrigin,
      productId,
      sequence: nextSequence,
      visible: after.visible,
      semanticHash,
      detailRevision: after.visible ? after.detailRevision : null,
      changedAt: new Date(now).toISOString(),
      latestEventId: hash([siteOrigin, productId, nextSequence, semanticHash]),
    });
    const nextTask = CatalogSeoTaskSchema.parse({
      _id: recordId,
      schemaVersion: 1,
      siteOrigin,
      productId,
      requestedSequence: nextSequence,
      acceptedSequence: task?.acceptedSequence ?? 0,
      state: task && task.state !== 'accepted' ? task.state : 'pending',
      attempts: task?.lease ? task.attempts : 0,
      lease: task?.lease ?? null,
    });
    writes.push(
      { collection: 'catalogPublicHeads', row: nextHead },
      { collection: 'catalogSeoTasks', row: nextTask },
    );
    kind = 'changed';
  } else if (head && after.visible && head.detailRevision !== after.detailRevision) {
    writes.push({
      collection: 'catalogPublicHeads',
      row: { ...head, detailRevision: after.detailRevision },
    });
    kind = 'metadata';
  }
  const plan = Object.freeze({ kind, productId, siteOrigin, sequence: nextSequence });
  prepared.set(plan, { store, writes, attempted: false });
  return plan;
}

/** Write only; the owning transaction must propagate any failure and roll back the business write. */
export async function writeCatalogPublicChange(
  store: CatalogPublicChangeStore,
  plan: CatalogPublicChangePlan,
): Promise<void> {
  const record = prepared.get(plan);
  if (!record || record.store !== store || record.attempted)
    throw new CatalogPublicChangeError('INVALID_PLAN');
  // After a partial/unknown write, retry the entire transaction, never this plan in isolation.
  record.attempted = true;
  for (const write of record.writes) await store.set(write.collection, structuredClone(write.row));
}

export function catalogPublicRecordId(siteOrigin: string, productId: string): string {
  return hash(['catalog-public-record-v1', origin.parse(siteOrigin), identity.parse(productId)]);
}

/** An untracked version needs delivery proof, but its original publication time is unknown. */
export async function planCatalogPublicRefresh(
  store: CatalogPublicChangeStore,
  input: unknown,
): Promise<CatalogPublicChangePlan> {
  const { siteOrigin, after, now } = z
    .object({ siteOrigin: origin, after: CatalogPublicStateSchema, now: timestamp })
    .strict()
    .parse(input);
  const recordId = catalogPublicRecordId(siteOrigin, after.productId);
  const old = await store.get('catalogPublicHeads', recordId);
  if (old) {
    const head = CatalogPublicHeadSchema.parse(old);
    const before: CatalogPublicState = head.visible
      ? {
          productId: head.productId,
          visible: true,
          semanticHash: head.semanticHash,
          detailRevision: head.detailRevision,
        }
      : { productId: head.productId, visible: false };
    // Retried saves can commit after requests with a later start time.
    const changedAt =
      head.changedAt && Date.parse(head.changedAt) > Date.parse(now) ? head.changedAt : now;
    return planCatalogPublicChange(store, { siteOrigin, before, after, now: changedAt });
  }
  if (await store.get('catalogSeoTasks', recordId))
    throw new CatalogPublicChangeError('CORRUPT_RECORD');
  const semanticHash = stateHash(after);
  const head = CatalogPublicHeadSchema.parse({
    _id: recordId,
    schemaVersion: 1,
    siteOrigin,
    productId: after.productId,
    sequence: 1,
    visible: after.visible,
    semanticHash,
    detailRevision: after.visible ? after.detailRevision : null,
    changedAt: null,
    latestEventId: hash([siteOrigin, after.productId, 1, semanticHash]),
  });
  const task = CatalogSeoTaskSchema.parse({
    _id: recordId,
    schemaVersion: 1,
    siteOrigin,
    productId: after.productId,
    requestedSequence: 1,
    acceptedSequence: 0,
    state: 'pending',
    attempts: 0,
    lease: null,
  });
  const plan = Object.freeze({
    kind: 'initialized' as const,
    productId: after.productId,
    siteOrigin,
    sequence: 1,
  });
  prepared.set(plan, {
    store,
    writes: [
      { collection: 'catalogPublicHeads', row: head },
      { collection: 'catalogSeoTasks', row: task },
    ],
    attempted: false,
  });
  return plan;
}
