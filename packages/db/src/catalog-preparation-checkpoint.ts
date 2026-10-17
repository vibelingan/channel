/** Private nonready diagnostics. Only the sealed final command may grant readiness. */
import { isDeepStrictEqual } from 'node:util';
import { type CatalogIssue, CatalogIssueSchema } from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
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
export const CatalogPreparationCheckpointCommandSchema = z
  .object({
    action: z.literal('checkpoint-preparation'),
    jobId: z.string().regex(/^[a-f0-9]{64}$/),
    lease: z.unknown(),
    previewReady: z.boolean(),
    issues: z.array(CatalogIssueSchema).max(50),
  })
  .strict();
export async function checkpointCatalogPreparation(
  tx: CatalogApprovalTransaction,
  authority: CatalogPreparationAuthority,
  job: CatalogPreparationJobRecord,
  command: z.infer<typeof CatalogPreparationCheckpointCommandSchema>,
  timestamp: string,
): Promise<CatalogPreparationJobResult> {
  if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
  const issues = [...command.issues];
  if (job.media?.invalid)
    appendIssue(
      issues,
      CatalogIssueSchema.parse({
        code: 'MEDIA_NOT_READY',
        stage: 'media',
        path: 'images',
        severity: 'error',
        remedy: 'edit',
        observed: { count: job.media.invalid },
      }),
    );
  if (job.media?.retry)
    appendIssue(
      issues,
      CatalogIssueSchema.parse({
        code: 'MEDIA_NOT_READY',
        stage: 'media',
        path: 'images',
        severity: 'warning',
        remedy: 'retry-media',
        observed: { count: job.media.retry },
      }),
    );
  const state = issues.some((i) => i.severity === 'error') ? 'blocked' : 'preparing';
  if (!command.previewReady && state !== 'blocked') return { ok: false, code: 'VALIDATION_ERROR' };
  const product = await tx.get('products', job.productId);
  if (product && product._id !== job.productId) return { ok: false, code: 'CORRUPT' };
  const current = product
    ? catalogPreparationInputDigest(await readCatalogPreparationInputs(tx, product))
    : null;
  if (!authority.currentLeaseScope(command.lease, job)) return { ok: false, code: 'CONFLICT' };
  function assertLease() {
    if (!authority.currentLeaseScope(command.lease, job))
      throw Error('Preparation lease changed during diagnostic checkpoint');
  }
  if (
    !product ||
    current !== job.inputDigest ||
    (product.catalogContentGeneration ?? 0) !== job.contentGeneration
  ) {
    await tx.set('catalogPreparationJobs', {
      ...job,
      state: 'stale',
      leaseOwner: '',
      leaseExpiresAt: 0,
      mutationRevision: job.mutationRevision + 1,
      updatedAt: timestamp,
    });
    assertLease();
    return { ok: false, code: 'STALE' };
  }
  const report = CatalogPreparationReportSchema.parse({
    schemaVersion: 'catalog-preparation-report-v2',
    productId: job.productId,
    inputDigest: job.inputDigest,
    policyVersion: CATALOG_PREPARATION_POLICY,
    contentGeneration: job.contentGeneration,
    checkedAt: timestamp,
    state,
    previewReady: command.previewReady,
    mediaReady: false,
    issues,
  });
  if (
    product.catalogPreparationState === report.state &&
    product.catalogPreparationPolicy === report.policyVersion &&
    isDeepStrictEqual(product.catalogPreparationReport, report)
  )
    return { ok: true, preparation: 'unchanged', productId: job.productId, report };
  await tx.set('products', {
    ...product,
    catalogPreparationState: report.state,
    catalogPreparationPolicy: report.policyVersion,
    catalogPreparationReport: report,
  });
  assertLease();
  await tx.set('catalogPreparationJobs', {
    ...job,
    mutationRevision: job.mutationRevision + 1,
    updatedAt: timestamp,
  });
  assertLease();
  return { ok: true, preparation: 'checkpointed', productId: job.productId, report };
}
function appendIssue(issues: CatalogIssue[], issue: CatalogIssue) {
  if (issues.some((i) => isDeepStrictEqual(i, issue))) return;
  if (issues.length < 50) {
    issues.push(issue);
    return;
  }
  // Keep an actual media error visible when other diagnostics fill the report.
  let warning = -1;
  for (let i = issues.length - 1; i >= 0; i--) {
    if (issues[i]?.severity === 'warning') {
      warning = i;
      break;
    }
  }
  if (warning >= 0) issues[warning] = issue;
  else if (issue.severity === 'error') issues[49] = issue;
}
