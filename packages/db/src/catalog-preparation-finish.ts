import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
/** Atomic readiness for current sealed inputs. This command never approves or publishes. */
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
  readCurrentCatalogPreparation,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobRecord,
  CatalogPreparationJobResult,
} from './catalog-preparation-jobs.ts';
import {
  catalogPreparationInputDigest,
  readCatalogPreparationInputs,
} from './catalog-preparation-store.ts';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
export const CatalogPreparationFinishCommandSchema = z
  .object({
    action: z.literal('finish-preparation'),
    jobId: hex,
    lease: z.unknown(),
    inputDigest: hex,
    contentGeneration: integer,
    planDigest: hex,
    imageIdsDigest: hex,
    imageCount: integer,
    previewReady: z.literal(true),
    issues: z
      .array(CatalogIssueSchema)
      .max(50)
      .refine((items) => items.every((i) => i.severity === 'warning')),
  })
  .strict();
export const CatalogPreparationCompletionSchema = z
  .object({
    kind: z.literal('catalog-preparation-completion-v1'),
    receiptId: hex,
    commandDigest: hex,
    reportDigest: hex,
    leaseOwner: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => v.trim() === v),
    leaseVersion: integer.min(1),
  })
  .strict();
export async function finishCatalogPreparation(
  tx: CatalogApprovalTransaction,
  authority: CatalogPreparationAuthority,
  job: CatalogPreparationJobRecord,
  command: z.infer<typeof CatalogPreparationFinishCommandSchema>,
  timestamp: string,
): Promise<CatalogPreparationJobResult> {
  const active = authority.currentLeaseScope(command.lease, job);
  const completion = job.completion ?? null;
  const replayScope = job.state === 'completed' ? authority.cleanupLeaseScope(command.lease) : null;
  const { lease: _lease, ...commandBody } = command;
  const commandDigest = alibabaPricingFingerprint(commandBody);
  const replay = Boolean(
    replayScope &&
      completion &&
      replayScope.jobId === job._id &&
      replayScope.leaseOwner === completion.leaseOwner &&
      replayScope.leaseVersion === completion.leaseVersion &&
      job.leaseVersion === completion.leaseVersion &&
      completion.commandDigest === commandDigest,
  );
  if (!active && !replay) return { ok: false, code: 'CONFLICT' };
  const media = job.media;
  const seal = job.mediaSeal;
  if (
    !media ||
    !seal ||
    media.planDigest !== command.planDigest ||
    seal.planDigest !== command.planDigest ||
    media.total !== command.imageCount ||
    media.cursor !== media.total ||
    media.verified !== media.total ||
    media.invalid !== 0 ||
    media.retry !== 0 ||
    seal.total !== media.total ||
    seal.cursor !== seal.total ||
    seal.imageIdsDigest !== command.imageIdsDigest ||
    seal.policyVersion !== CATALOG_MEDIA_SEAL_POLICY ||
    seal.pixelPolicyVersion !== CATALOG_PIXEL_POLICY ||
    command.inputDigest !== job.inputDigest ||
    command.contentGeneration !== job.contentGeneration
  )
    return { ok: false, code: 'CONFLICT' };
  const product = await tx.get('products', job.productId);
  const current =
    product && product._id === job.productId
      ? {
          inputDigest: catalogPreparationInputDigest(
            await readCatalogPreparationInputs(tx, product),
          ),
          generation: product.catalogContentGeneration ?? 0,
        }
      : null;
  // Recheck the service clock after asynchronous reads, before any writes.
  if (active && !authority.currentLeaseScope(command.lease, job))
    return { ok: false, code: 'CONFLICT' };
  if (
    !product ||
    !current ||
    current.inputDigest !== job.inputDigest ||
    current.generation !== job.contentGeneration
  ) {
    if (active)
      await tx.set('catalogPreparationJobs', {
        ...job,
        state: 'stale',
        leaseOwner: '',
        leaseExpiresAt: 0,
        mutationRevision: job.mutationRevision + 1,
        updatedAt: timestamp,
      });
    return { ok: false, code: 'STALE' };
  }
  if (replay) {
    const report = completedPreparationReport(job, product);
    if (!report) return { ok: false, code: 'CONFLICT' };
    return { ok: true, preparation: 'unchanged', productId: job.productId, report };
  }
  if (!active) return { ok: false, code: 'CONFLICT' };
  const receiptId = alibabaPricingFingerprint([
    'catalog-preparation-completion-v1',
    job._id,
    job.nonce,
    active.leaseOwner,
    active.leaseVersion,
    commandDigest,
  ]);
  const report = CatalogPreparationReportSchema.parse({
    schemaVersion: 'catalog-preparation-report-v2',
    productId: job.productId,
    inputDigest: job.inputDigest,
    policyVersion: CATALOG_PREPARATION_POLICY,
    contentGeneration: job.contentGeneration,
    checkedAt: timestamp,
    state: 'ready',
    previewReady: true,
    mediaReady: true,
    issues: command.issues,
    seal: {
      kind: 'catalog-preparation-ready-seal-v1',
      jobId: job._id,
      receiptId,
      planDigest: command.planDigest,
      imageIdsDigest: command.imageIdsDigest,
      imageCount: command.imageCount,
      mediaPolicyVersion: CATALOG_MEDIA_SEAL_POLICY,
      pixelPolicyVersion: CATALOG_PIXEL_POLICY,
    },
  });
  const receipt = CatalogPreparationCompletionSchema.parse({
    kind: 'catalog-preparation-completion-v1',
    receiptId,
    commandDigest,
    reportDigest: alibabaPricingFingerprint(report),
    leaseOwner: active.leaseOwner,
    leaseVersion: active.leaseVersion,
  });
  await tx.set('products', {
    ...product,
    catalogPreparationState: 'ready',
    catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
    catalogPreparationReport: report,
  });
  if (!authority.currentLeaseScope(command.lease, job))
    throw Error('Preparation lease changed during readiness commit');
  await tx.set('catalogPreparationJobs', {
    ...job,
    state: 'completed',
    leaseOwner: '',
    leaseExpiresAt: 0,
    completion: receipt,
    mutationRevision: job.mutationRevision + 1,
    updatedAt: timestamp,
  });
  if (!authority.currentLeaseScope(command.lease, job))
    throw Error('Preparation lease changed during readiness commit');
  return { ok: true, preparation: 'ready', productId: job.productId, report };
}

/** Check a saved server receipt without granting a new lease. */
function completedPreparationReport(job: CatalogPreparationJobRecord, product: CollectionDoc) {
  const report = readCurrentCatalogPreparation(product);
  const done = job.completion;
  const media = job.media;
  const seal = job.mediaSeal;
  if (
    job.state !== 'completed' ||
    !done ||
    report?.state !== 'ready' ||
    !media ||
    !seal ||
    report.inputDigest !== job.inputDigest ||
    report.seal.jobId !== job._id ||
    report.seal.receiptId !== done.receiptId ||
    done.leaseVersion !== job.leaseVersion ||
    alibabaPricingFingerprint(report) !== done.reportDigest ||
    done.receiptId !==
      alibabaPricingFingerprint([
        'catalog-preparation-completion-v1',
        job._id,
        job.nonce,
        done.leaseOwner,
        done.leaseVersion,
        done.commandDigest,
      ]) ||
    media.cursor !== media.total ||
    media.verified !== media.total ||
    media.invalid !== 0 ||
    media.retry !== 0 ||
    seal.cursor !== seal.total ||
    seal.total !== media.total ||
    seal.policyVersion !== CATALOG_MEDIA_SEAL_POLICY ||
    seal.pixelPolicyVersion !== CATALOG_PIXEL_POLICY ||
    report.seal.planDigest !== media.planDigest ||
    report.seal.planDigest !== seal.planDigest ||
    report.seal.imageIdsDigest !== seal.imageIdsDigest ||
    report.seal.imageCount !== seal.total
  )
    return null;
  return report;
}
export async function readCompletedCatalogPreparation(
  tx: CatalogApprovalTransaction,
  job: CatalogPreparationJobRecord,
): Promise<CatalogPreparationJobResult> {
  const product = await tx.get('products', job.productId);
  if (!product) return { ok: false, code: 'STALE' };
  if (product._id !== job.productId) return { ok: false, code: 'CORRUPT' };
  if (
    (product.catalogContentGeneration ?? 0) !== job.contentGeneration ||
    catalogPreparationInputDigest(await readCatalogPreparationInputs(tx, product)) !==
      job.inputDigest
  )
    return { ok: false, code: 'STALE' };
  const report = completedPreparationReport(job, product);
  return report
    ? { ok: true, preparation: 'unchanged', productId: job.productId, report }
    : { ok: false, code: 'CONFLICT' };
}
