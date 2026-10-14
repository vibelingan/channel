import { isDeepStrictEqual } from 'node:util';
/** Private check snapshots. All reads are bounded point reads; results grant no publish authority. */
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogIssueSchema,
  type CatalogValidationReport,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import { catalogProductContentDigest } from './catalog-product-state.ts';
import {
  normalizedSourceInputDigest,
  sourceCaptureMatches,
  sourceInputDigest,
} from './catalog-source-inputs.ts';

export const CatalogPreparationCommitSchema = z
  .object({
    action: z.literal('preparation-report'),
    report: CatalogPreparationReportSchema,
  })
  .strict();
export type CatalogPreparationInputs = {
  product: CollectionDoc;
  source: CollectionDoc | null;
  observation: CollectionDoc | null;
  link: CollectionDoc | null;
};
export function catalogPreparationInputDigest(input: CatalogPreparationInputs): string {
  return alibabaPricingFingerprint([
    CATALOG_PREPARATION_POLICY,
    input.product._id,
    input.product.catalogContentGeneration ?? 0,
    catalogProductContentDigest(input.product),
    normalizedSourceInputDigest(input.source),
    sourceInputDigest(input.observation),
    input.link,
    input.observation?.sourceContentHash === undefined && input.source?.contentHash !== undefined
      ? (input.source.payloadId ?? null)
      : null,
    input.source && input.observation
      ? sourceCaptureMatches(input.source, input.observation)
      : false,
  ]);
}
export async function readCatalogPreparationInputs(
  store: { get(collection: string, id: string): Promise<CollectionDoc | null> },
  product: CollectionDoc,
): Promise<CatalogPreparationInputs> {
  const key = product.alibabaPrimarySourceKey;
  if (typeof key !== 'string' || key === '')
    return { product, source: null, observation: null, link: null };
  const [source, observation, link] = await Promise.all([
    store.get('alibabaSourceProducts', key),
    store.get('catalogSourceObservations', sourceObservationDocumentId('alibaba', key)),
    store.get('alibabaProductLinks', key),
  ]);
  return { product, source, observation, link };
}

export type CatalogPreparationStoreResult =
  | { ok: true; preparation: 'stored' | 'unchanged'; productId: string }
  | {
      ok: false;
      code: 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR';
      validation?: CatalogValidationReport;
    };

export async function storeCatalogPreparationReport(
  tx: CatalogApprovalTransaction,
  actorId: string,
  command: z.infer<typeof CatalogPreparationCommitSchema>,
): Promise<CatalogPreparationStoreResult> {
  const actor = await tx.get('users', actorId);
  if (actor?._id !== actorId || actor.role !== 'admin' || actor.status === 'suspended')
    return { ok: false, code: 'FORBIDDEN' };
  const report = command.report;
  const product = await tx.get('products', report.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND' };
  const generation = product.catalogContentGeneration ?? 0;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0)
    return catalogValidationFailure('commit', [
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        stage: 'commit',
        path: 'catalogContentGeneration',
        severity: 'error',
        remedy: 'system-repair',
      }),
    ]);
  if (
    product._id !== report.productId ||
    report.policyVersion !== CATALOG_PREPARATION_POLICY ||
    report.contentGeneration !== generation
  )
    return { ok: false, code: 'CONFLICT' };
  const current = await readCatalogPreparationInputs(tx, product);
  if (catalogPreparationInputDigest(current) !== report.inputDigest)
    return { ok: false, code: 'CONFLICT' };
  if (
    product.catalogPreparationState === report.state &&
    product.catalogPreparationPolicy === report.policyVersion &&
    isDeepStrictEqual(product.catalogPreparationReport, report)
  )
    return { ok: true, preparation: 'unchanged', productId: product._id };
  await tx.set('products', {
    ...product,
    catalogPreparationState: report.state,
    catalogPreparationPolicy: report.policyVersion,
    catalogPreparationReport: report,
  });
  return { ok: true, preparation: 'stored', productId: product._id };
}
