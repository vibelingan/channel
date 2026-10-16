/** Private technical jobs. Pixel work runs outside the transaction; every write is fenced inside it. */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { IMAGE_MUTATION_STALE_MS, readImageMutationState } from './adapter.ts';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from './catalog-image-input.ts';
import {
  CATALOG_IMAGE_OBSERVATIONS,
  type CatalogImageObservation,
  CatalogImageObservationHealthSchema,
  CatalogImageObservationRecordSchema,
} from './catalog-image-observation.ts';
import {
  type CatalogImageProtectionIntent,
  CatalogProtectedTargetSchema,
} from './catalog-image-protection-contract.ts';
import { runCatalogImageProtection } from './catalog-image-protection.ts';
import type { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import {
  type CatalogPreparationMediaProgress,
  CatalogPreparationMediaProgressSchema,
  advanceCatalogMediaProgress,
  catalogMediaStepReceipt,
  initialCatalogMediaProgress,
} from './catalog-preparation-media-progress.ts';
import {
  catalogPreparationInputDigest,
  readCatalogPreparationInputs,
} from './catalog-preparation-store.ts';
import {
  planCatalogProtectedPixels,
  readCatalogProtectedPixels,
} from './catalog-protected-pixels.ts';
import type { ImageDeletionStore } from './image-deletion.ts';
import {
  SourceMediaImportCommandSchema,
  type SourceMediaImportResult,
  runSourceMediaImport,
} from './source-media-import.ts';

export const CATALOG_PREPARATION_JOBS = 'catalogPreparationJobs';
export type CatalogPreparationAuthority = ReturnType<typeof createCatalogPreparationAuthority>;
const ttl = 120_000;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const instantSchema = z
  .string()
  .datetime()
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  });
const human = z.object({ actorId: id, jobId: hex });
const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('manage-source-media'),
      jobId: hex,
      lease: z.unknown(),
      command: SourceMediaImportCommandSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('get-protected-image-health'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('begin-image-protection'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
      imageInputDigest: hex,
    })
    .strict(),
  z
    .object({
      action: z.literal('checkpoint-image-protection'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
      intentId: hex,
      target: CatalogProtectedTargetSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('commit-image-protection'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
      intentId: hex,
      health: CatalogImageObservationHealthSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('release-image-protection'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
      intentId: hex,
    })
    .strict(),
  z.object({ action: z.literal('start'), actorId: id, productId: id }).strict(),
  human.extend({ action: z.literal('get') }).strict(),
  human.extend({ action: z.literal('dispatch') }).strict(),
  human.extend({ action: z.literal('cancel'), expectedLeaseVersion: integer }).strict(),
  human.extend({ action: z.literal('retry'), expectedLeaseVersion: integer }).strict(),
  z.object({ action: z.literal('claim'), call: z.unknown(), owner: id }).strict(),
  z.object({ action: z.literal('renew'), jobId: hex, lease: z.unknown() }).strict(),
  z.object({ action: z.literal('release'), jobId: hex, lease: z.unknown() }).strict(),
  z
    .object({
      action: z.literal('bind-media-plan'),
      jobId: hex,
      lease: z.unknown(),
      planDigest: hex,
      total: integer,
    })
    .strict(),
  z
    .object({
      action: z.literal('advance-media-check'),
      jobId: hex,
      lease: z.unknown(),
      planDigest: hex,
      index: integer,
      imageId: id,
      imageInputDigest: hex.nullable(),
      health: CatalogImageObservationHealthSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('get-image-check'), jobId: hex, lease: z.unknown(), imageId: id })
    .strict(),
  z
    .object({
      action: z.literal('put-image-check'),
      jobId: hex,
      lease: z.unknown(),
      imageId: id,
      imageInputDigest: hex.nullable(),
      health: CatalogImageObservationHealthSchema,
    })
    .strict(),
]);
export type CatalogPreparationJobCommand = z.infer<typeof commandSchema>;
const jobSchema = z
  .object({
    schemaVersion: z.literal('catalog-preparation-job-v1'),
    _id: hex,
    nonce: hex,
    productId: id,
    inputDigest: hex,
    contentGeneration: integer,
    policyVersion: z.literal(CATALOG_PREPARATION_POLICY),
    state: z.enum(['queued', 'running', 'retryable', 'cancelled', 'stale', 'blocked', 'completed']),
    leaseOwner: z.string().max(200),
    leaseVersion: integer,
    leaseExpiresAt: integer,
    attempt: integer,
    mutationRevision: integer,
    media: CatalogPreparationMediaProgressSchema.nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict()
  .refine((job) =>
    job.state === 'running'
      ? job.leaseOwner.length > 0 &&
        job.leaseOwner.trim() === job.leaseOwner &&
        job.leaseVersion > 0 &&
        job.leaseExpiresAt > 0
      : job.leaseOwner === '' && job.leaseExpiresAt === 0,
  )
  .refine(
    (job) =>
      job.updatedAt >= job.createdAt &&
      job.leaseVersion >= job.attempt &&
      (job.state !== 'running' || job.attempt > 0),
  );
type Job = z.infer<typeof jobSchema>;
export type CatalogPreparationJobRecord = Job;
export type CatalogPreparationJobProgress = Readonly<{
  jobId: string;
  productId: string;
  state: Job['state'];
  attempt: number;
  leaseVersion: number;
  leaseExpiresAt: number;
  createdAt: string;
  updatedAt: string;
  media: Readonly<{
    total: number;
    checked: number;
    verified: number;
    invalid: number;
    retry: number;
  }> | null;
}>;
export type CatalogPreparationJobResult =
  | { ok: true; progress: CatalogPreparationJobProgress }
  | { ok: true; progress: CatalogPreparationJobProgress; lease: object }
  | { ok: true; call: ReturnType<CatalogPreparationAuthority['issueCall']> }
  | { ok: true; observation: CatalogImageObservation | null }
  | { ok: true; protection: CatalogImageProtectionIntent }
  | { ok: true; sourceMedia: SourceMediaImportResult }
  | {
      ok: true;
      protectedHealth: Extract<CatalogImageObservation['health'], { status: 'verified' }> | null;
    }
  | { ok: true; media: Readonly<CatalogPreparationMediaProgress> }
  | {
      ok: false;
      code:
        | 'FORBIDDEN'
        | 'VALIDATION_ERROR'
        | 'NOT_FOUND'
        | 'CORRUPT'
        | 'CONFLICT'
        | 'BUSY'
        | 'STALE';
    };
function progress(job: Job): CatalogPreparationJobProgress {
  return Object.freeze({
    jobId: job._id,
    productId: job.productId,
    state: job.state,
    attempt: job.attempt,
    leaseVersion: job.leaseVersion,
    leaseExpiresAt: job.leaseExpiresAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    media: job.media
      ? Object.freeze({
          total: job.media.total,
          checked: job.media.cursor,
          verified: job.media.verified,
          invalid: job.media.invalid,
          retry: job.media.retry,
        })
      : null,
  });
}
function identity(productId: string, inputDigest: string, generation: number) {
  return alibabaPricingFingerprint([
    CATALOG_PREPARATION_POLICY,
    productId,
    inputDigest,
    generation,
  ]);
}
function readJob(value: unknown, jobId: string, now: number): Job | null {
  const checked = jobSchema.safeParse(value);
  if (!checked.success) return null;
  const job = checked.data;
  return job._id === jobId &&
    identity(job.productId, job.inputDigest, job.contentGeneration) === jobId &&
    job.leaseExpiresAt - now <= ttl + 5_000 &&
    Date.parse(job.createdAt) - now <= 5_000 &&
    Date.parse(job.updatedAt) - now <= 5_000
    ? job
    : null;
}
async function currentInput(tx: CatalogApprovalTransaction, productId: string) {
  const product = await tx.get('products', productId);
  if (!product) return null;
  if (product._id !== productId) return 'invalid';
  const generation = integer.safeParse(product.catalogContentGeneration ?? 0);
  if (!generation.success) return 'invalid';
  return {
    inputDigest: catalogPreparationInputDigest(await readCatalogPreparationInputs(tx, product)),
    contentGeneration: generation.data,
  };
}

export async function runCatalogPreparationJob(
  tx: CatalogApprovalTransaction & Partial<Pick<ImageDeletionStore, 'remove'>>,
  authority: CatalogPreparationAuthority,
  input: unknown,
  now = Date.now(),
): Promise<CatalogPreparationJobResult> {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttl))
    throw new Error('Invalid preparation job clock');
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid preparation job clock');
  let timestamp = instantSchema.parse(instant.toISOString());
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const command = parsed.data;
  if ('actorId' in command) {
    const actor = await tx.get('users', command.actorId);
    if (
      !actor ||
      actor._id !== command.actorId ||
      actor.role !== 'admin' ||
      actor.status === 'suspended'
    )
      return { ok: false, code: 'FORBIDDEN' };
  }
  if (command.action === 'start') {
    const current = await currentInput(tx, command.productId);
    if (!current) return { ok: false, code: 'NOT_FOUND' };
    if (current === 'invalid') return { ok: false, code: 'CORRUPT' };
    const jobId = identity(command.productId, current.inputDigest, current.contentGeneration);
    const existing = await tx.get(CATALOG_PREPARATION_JOBS, jobId);
    if (existing) {
      const checked = readJob(existing, jobId, now);
      return checked &&
        checked.productId === command.productId &&
        checked.inputDigest === current.inputDigest &&
        checked.contentGeneration === current.contentGeneration
        ? { ok: true, progress: progress(checked) }
        : { ok: false, code: 'CORRUPT' };
    }
    const job: Job = {
      schemaVersion: 'catalog-preparation-job-v1',
      _id: jobId,
      nonce: randomBytes(32).toString('hex'),
      productId: command.productId,
      ...current,
      policyVersion: CATALOG_PREPARATION_POLICY,
      state: 'queued',
      leaseOwner: '',
      leaseVersion: 0,
      leaseExpiresAt: 0,
      attempt: 0,
      mutationRevision: 0,
      media: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await tx.set(CATALOG_PREPARATION_JOBS, job);
    return { ok: true, progress: progress(job) };
  }
  let ticket: object | null = null;
  let jobId: string;
  if (command.action === 'claim') {
    ticket = authority.verifyCall(command.call);
    const locator = z.object({ jobId: hex }).safeParse(command.call);
    if (!ticket || !locator.success) return { ok: false, code: 'FORBIDDEN' };
    jobId = locator.data.jobId;
  } else jobId = command.jobId;
  const existing = await tx.get(CATALOG_PREPARATION_JOBS, jobId);
  if (!existing) return { ok: false, code: 'NOT_FOUND' };
  const job = readJob(existing, jobId, now);
  if (!job) return { ok: false, code: 'CORRUPT' };
  timestamp = new Date(Math.max(now, Date.parse(job.updatedAt))).toISOString();
  if (command.action === 'get') return { ok: true, progress: progress(job) };
  if (!Number.isSafeInteger(job.mutationRevision + 1)) return { ok: false, code: 'CORRUPT' };
  if (command.action === 'cancel' || command.action === 'retry') {
    if (command.expectedLeaseVersion !== job.leaseVersion) return { ok: false, code: 'CONFLICT' };
    if (command.action === 'cancel') {
      if (job.state === 'cancelled') return { ok: true, progress: progress(job) };
      if (!['queued', 'running', 'retryable'].includes(job.state))
        return { ok: false, code: 'CONFLICT' };
      const saved: Job = {
        ...job,
        mutationRevision: job.mutationRevision + 1,
        state: 'cancelled',
        leaseOwner: '',
        leaseExpiresAt: 0,
        updatedAt: timestamp,
      };
      await tx.set(CATALOG_PREPARATION_JOBS, saved);
      return { ok: true, progress: progress(saved) };
    }
    const restartScan = job.state === 'queued' && job.media !== null;
    if (!['cancelled', 'retryable'].includes(job.state) && !restartScan)
      return { ok: false, code: 'CONFLICT' };
    if (!Number.isSafeInteger(job.leaseVersion + 1)) return { ok: false, code: 'CORRUPT' };
    const current = await currentInput(tx, job.productId);
    if (
      !current ||
      current === 'invalid' ||
      current.inputDigest !== job.inputDigest ||
      current.contentGeneration !== job.contentGeneration
    )
      return { ok: false, code: 'STALE' };
    const saved: Job = {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      nonce: randomBytes(32).toString('hex'),
      media: null,
      state: 'queued',
      leaseVersion: job.leaseVersion + 1,
      leaseOwner: '',
      leaseExpiresAt: 0,
      updatedAt: timestamp,
    };
    await tx.set(CATALOG_PREPARATION_JOBS, saved);
    return { ok: true, progress: progress(saved) };
  }
  if (command.action === 'dispatch') {
    if (!['queued', 'running'].includes(job.state)) return { ok: false, code: 'CONFLICT' };
    return { ok: true, call: authority.issueCall({ jobId, nonce: job.nonce }) };
  }
  if (command.action === 'manage-source-media') {
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (command.command.action === 'retire') return { ok: false, code: 'FORBIDDEN' };
    const remove = tx.remove;
    if (!remove) return { ok: false, code: 'CORRUPT' };
    const current = await currentInput(tx, job.productId);
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (
      !current ||
      current === 'invalid' ||
      current.inputDigest !== job.inputDigest ||
      current.contentGeneration !== job.contentGeneration
    ) {
      await tx.set(CATALOG_PREPARATION_JOBS, {
        ...job,
        mutationRevision: job.mutationRevision + 1,
        state: 'stale',
        leaseOwner: '',
        leaseExpiresAt: 0,
        updatedAt: timestamp,
      });
      return { ok: false, code: 'STALE' };
    }
    // Throw after any intervening expiry so the caller's transaction rolls back all source rows.
    const assertLease = () => {
      if (!authority.currentLeaseScope(command.lease, job))
        throw Error('Catalog preparation lease changed during source media import');
    };
    const result = await runSourceMediaImport(
      {
        get: (collection, id) => tx.get(collection, id),
        set: async (collection, row) => {
          assertLease();
          await tx.set(collection, row);
        },
        remove: async (collection, id) => {
          assertLease();
          await remove.call(tx, collection, id);
        },
      },
      { ...command.command, now: timestamp },
    );
    assertLease();
    await tx.set(CATALOG_PREPARATION_JOBS, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    return { ok: true, sourceMedia: result };
  }
  if (command.action === 'get-protected-image-health') {
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    const image = await tx.get('images', command.imageId);
    if (image && image._id !== command.imageId) return { ok: false, code: 'CORRUPT' };
    const health = await readCatalogProtectedPixels(tx, image, now);
    const current = await currentInput(tx, job.productId);
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (
      !current ||
      current === 'invalid' ||
      current.inputDigest !== job.inputDigest ||
      current.contentGeneration !== job.contentGeneration
    ) {
      await tx.set(CATALOG_PREPARATION_JOBS, {
        ...job,
        mutationRevision: job.mutationRevision + 1,
        state: 'stale',
        leaseOwner: '',
        leaseExpiresAt: 0,
        updatedAt: timestamp,
      });
      return { ok: false, code: 'STALE' };
    }
    return { ok: true, protectedHealth: health ? Object.freeze({ ...health }) : null };
  }
  if (
    command.action === 'begin-image-protection' ||
    command.action === 'checkpoint-image-protection' ||
    command.action === 'commit-image-protection' ||
    command.action === 'release-image-protection'
  ) {
    return runCatalogImageProtection(
      tx,
      authority,
      job,
      command,
      now,
      timestamp,
      readJob,
      currentInput,
    );
  }
  if (command.action === 'bind-media-plan') {
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (
      job.media &&
      (job.media.planDigest !== command.planDigest || job.media.total !== command.total)
    )
      return { ok: false, code: 'CONFLICT' };
    const current = await currentInput(tx, job.productId);
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (
      !current ||
      current === 'invalid' ||
      current.inputDigest !== job.inputDigest ||
      current.contentGeneration !== job.contentGeneration
    ) {
      await tx.set(CATALOG_PREPARATION_JOBS, {
        ...job,
        mutationRevision: job.mutationRevision + 1,
        state: 'stale',
        leaseOwner: '',
        leaseExpiresAt: 0,
        updatedAt: timestamp,
      });
      return { ok: false, code: 'STALE' };
    }
    const media = job.media ?? initialCatalogMediaProgress(command.planDigest, command.total);
    await tx.set(CATALOG_PREPARATION_JOBS, {
      ...job,
      media,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    return { ok: true, media: Object.freeze({ ...media }) };
  }
  if (
    command.action === 'get-image-check' ||
    command.action === 'put-image-check' ||
    command.action === 'advance-media-check'
  ) {
    const scope = authority.currentLeaseScope(command.lease, job);
    if (!scope) return { ok: false, code: 'CONFLICT' };
    const stepReceipt =
      command.action === 'advance-media-check' ? catalogMediaStepReceipt(command) : null;
    if (
      command.action === 'advance-media-check' &&
      (!job.media ||
        job.media.planDigest !== command.planDigest ||
        command.index >= job.media.total ||
        (command.index !== job.media.cursor &&
          !(command.index === job.media.cursor - 1 && job.media.lastReceipt === stepReceipt)))
    )
      return { ok: false, code: 'CONFLICT' };
    const image = await tx.get('images', command.imageId);
    const imageInputDigest = image ? storedCatalogImageInputDigest(image) : null;
    if (command.action !== 'get-image-check' && command.imageInputDigest !== imageInputDigest)
      return { ok: false, code: 'CONFLICT' };
    const observationId = alibabaPricingFingerprint([
      CATALOG_PREPARATION_POLICY,
      job._id,
      job.nonce,
      job.inputDigest,
      command.imageId,
      imageInputDigest,
    ]);
    const previous = await tx.get(CATALOG_IMAGE_OBSERVATIONS, observationId);
    const pixelReceipt =
      command.action === 'get-image-check'
        ? null
        : await planCatalogProtectedPixels(tx, image, command.health, timestamp);
    const current = await currentInput(tx, job.productId);
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    if (
      !current ||
      current === 'invalid' ||
      current.inputDigest !== job.inputDigest ||
      current.contentGeneration !== job.contentGeneration
    ) {
      await tx.set(CATALOG_PREPARATION_JOBS, {
        ...job,
        mutationRevision: job.mutationRevision + 1,
        state: 'stale',
        leaseOwner: '',
        leaseExpiresAt: 0,
        updatedAt: timestamp,
      });
      return { ok: false, code: 'STALE' };
    }
    if (image) {
      const lock = readImageMutationState(image);
      if (lock.state !== 'free')
        return {
          ok: false,
          code:
            lock.state === 'owned' && now - Date.parse(lock.startedAt) < IMAGE_MUTATION_STALE_MS
              ? 'BUSY'
              : 'CORRUPT',
        };
    }
    const existing = previous ? CatalogImageObservationRecordSchema.safeParse(previous) : null;
    if (
      previous &&
      (!existing?.success ||
        existing.data._id !== observationId ||
        existing.data.jobId !== job._id ||
        existing.data.productId !== job.productId ||
        existing.data.inputDigest !== job.inputDigest ||
        existing.data.contentGeneration !== job.contentGeneration ||
        existing.data.imageId !== command.imageId ||
        existing.data.imageInputDigest !== imageInputDigest ||
        !matchesImageObservation(existing.data.health, image, command.imageId, imageInputDigest))
    )
      return { ok: false, code: 'CORRUPT' };
    if (
      command.action !== 'get-image-check' &&
      !matchesImageObservation(command.health, image, command.imageId, imageInputDigest)
    )
      return { ok: false, code: 'CONFLICT' };
    const observed = existing?.success ? existing.data : null;
    const record: CatalogImageObservation | null =
      command.action === 'get-image-check'
        ? observed
        : observed && isDeepStrictEqual(observed.health, command.health)
          ? observed
          : {
              _id: observationId,
              kind: 'unsealed-image-observation-v1',
              policyVersion: CATALOG_PREPARATION_POLICY,
              jobId: job._id,
              productId: job.productId,
              inputDigest: job.inputDigest,
              contentGeneration: job.contentGeneration,
              imageId: command.imageId,
              imageInputDigest,
              checkedAt: timestamp,
              health: command.health,
            };
    let media = job.media;
    if (command.action === 'advance-media-check') {
      if (!media || !stepReceipt || !record) return { ok: false, code: 'CORRUPT' };
      if (command.index < media.cursor) {
        if (!observed || !isDeepStrictEqual(observed.health, command.health))
          return { ok: false, code: 'CORRUPT' };
        return { ok: true, media: Object.freeze({ ...media }) };
      }
      media = advanceCatalogMediaProgress(media, stepReceipt, command.health.status);
    }
    await tx.set(CATALOG_PREPARATION_JOBS, {
      ...job,
      media,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    if (command.action !== 'get-image-check' && record !== observed && record)
      await tx.set(CATALOG_IMAGE_OBSERVATIONS, record);
    if (pixelReceipt) await tx.set(CATALOG_IMAGE_OBSERVATIONS, pixelReceipt);
    if (command.action === 'advance-media-check' && media)
      return { ok: true, media: Object.freeze({ ...media }) };
    return {
      ok: true,
      observation: record
        ? Object.freeze({ ...record, health: Object.freeze({ ...record.health }) })
        : null,
    };
  }
  let lease: object | null = null;
  let saved: Job;
  if (command.action === 'claim') {
    if (!Number.isSafeInteger(job.leaseVersion + 1) || !Number.isSafeInteger(job.attempt + 1))
      return { ok: false, code: 'CORRUPT' };
    saved = {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      state: 'running',
      leaseOwner: command.owner,
      leaseVersion: job.leaseVersion + 1,
      leaseExpiresAt: now + ttl,
      attempt: job.attempt + 1,
      updatedAt: timestamp,
    };
    lease = authority.bindLease(ticket, saved, command.owner);
    if (!lease) return { ok: false, code: 'FORBIDDEN' };
    if (job.state === 'running' && job.leaseExpiresAt > now) return { ok: false, code: 'BUSY' };
    if (job.state !== 'queued' && job.state !== 'running') return { ok: false, code: 'CONFLICT' };
  } else {
    if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
    saved = {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      state: command.action === 'renew' ? 'running' : 'queued',
      leaseOwner: command.action === 'renew' ? job.leaseOwner : '',
      leaseExpiresAt: command.action === 'renew' ? now + ttl : 0,
      updatedAt: timestamp,
    };
  }
  const current = await currentInput(tx, job.productId);
  const currentLease = command.action === 'claim' ? lease : command.lease;
  const leaseRow = command.action === 'claim' ? saved : job;
  if (!authority.currentLeaseScope(currentLease, leaseRow)) return { ok: false, code: 'CONFLICT' };
  if (
    !current ||
    current === 'invalid' ||
    current.inputDigest !== job.inputDigest ||
    current.contentGeneration !== job.contentGeneration
  ) {
    await tx.set(CATALOG_PREPARATION_JOBS, {
      ...job,
      mutationRevision: job.mutationRevision + 1,
      state: 'stale',
      leaseOwner: '',
      leaseExpiresAt: 0,
      updatedAt: timestamp,
    });
    return { ok: false, code: 'STALE' };
  }
  await tx.set(CATALOG_PREPARATION_JOBS, saved);
  return lease
    ? { ok: true, progress: progress(saved), lease }
    : { ok: true, progress: progress(saved) };
}

function matchesImageObservation(
  health: CatalogImageObservation['health'],
  image: Awaited<ReturnType<CatalogApprovalTransaction['get']>>,
  imageId: string,
  digest: string | null,
) {
  return (
    health.status !== 'verified' ||
    (isStoredCatalogImageRecord(image, imageId) &&
      health.imageId === imageId &&
      health.inputDigest === digest &&
      health.byteSize === image.byteSize &&
      health.checksumSha256 === image.checksumSha256)
  );
}
