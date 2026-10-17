/** Bounded private check results. They describe saved inputs and never authorize publication. */
import { z } from 'zod';
import { CatalogIssueSchema } from './issues.ts';

export const CATALOG_PREPARATION_POLICY = 'catalog-preparation-v1';
export const CATALOG_MEDIA_SEAL_POLICY = 'catalog-protected-media-seal-v1';
export const CATALOG_PIXEL_POLICY = 'catalog-pixels-v1';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogPreparationReadySealSchema = z
  .object({
    kind: z.literal('catalog-preparation-ready-seal-v1'),
    jobId: hex,
    receiptId: hex,
    planDigest: hex,
    imageIdsDigest: hex,
    imageCount: z.number().int().nonnegative().safe(),
    mediaPolicyVersion: z.literal(CATALOG_MEDIA_SEAL_POLICY),
    pixelPolicyVersion: z.literal(CATALOG_PIXEL_POLICY),
  })
  .strict();
const issues = z.array(CatalogIssueSchema).max(50);
const warnings = issues.refine((items) => items.every((issue) => issue.severity === 'warning'));
const base = z.object({
  schemaVersion: z.literal('catalog-preparation-report-v2'),
  productId: z.string().trim().min(1).max(200),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.string().trim().min(1).max(100),
  contentGeneration: z.number().int().nonnegative().safe(),
  checkedAt: z.string().max(40).datetime(),
});
export const CatalogPreparationReportSchema = z.discriminatedUnion('state', [
  base
    .extend({
      state: z.literal('ready'),
      seal: CatalogPreparationReadySealSchema,
      previewReady: z.literal(true),
      mediaReady: z.literal(true),
      issues: warnings,
    })
    .strict(),
  base
    .extend({
      state: z.literal('preparing'),
      previewReady: z.literal(true),
      mediaReady: z.literal(false),
      issues: warnings,
    })
    .strict(),
  base
    .extend({
      state: z.literal('blocked'),
      previewReady: z.boolean(),
      mediaReady: z.boolean(),
      issues: issues.refine((items) => items.some((issue) => issue.severity === 'error')),
    })
    .strict(),
]);
export type CatalogPreparationReport = z.infer<typeof CatalogPreparationReportSchema>;

/** A legacy/malformed/older-policy result remains unverified; no coercion grants ready. */
export function readCurrentCatalogPreparation(
  product: Record<string, unknown>,
): CatalogPreparationReport | null {
  const checked = CatalogPreparationReportSchema.safeParse(product.catalogPreparationReport);
  if (!checked.success) return null;
  const report = checked.data;
  return report.productId === product._id &&
    report.policyVersion === CATALOG_PREPARATION_POLICY &&
    product.catalogPreparationPolicy === report.policyVersion &&
    product.catalogPreparationState === report.state &&
    report.contentGeneration === (product.catalogContentGeneration ?? 0)
    ? report
    : null;
}

/** A requested check is diagnostic; it is not a content or publication approval. */
export const CatalogPreparationRequestSchema = z
  .object({
    schemaVersion: z.literal('catalog-preparation-request-v1'),
    productId: z.string().trim().min(1).max(200),
    jobId: hex,
    inputDigest: hex,
    contentGeneration: z.number().int().nonnegative().safe(),
    policyVersion: z.string().trim().min(1).max(100),
    requestedAt: z.string().max(40).datetime(),
  })
  .strict();
export type CatalogPreparationRequest = z.infer<typeof CatalogPreparationRequestSchema>;

export function readCurrentCatalogPreparationRequest(
  product: Record<string, unknown>,
): CatalogPreparationRequest | null {
  const checked = CatalogPreparationRequestSchema.safeParse(product.catalogPreparationRequest);
  if (!checked.success) return null;
  const request = checked.data;
  return product.catalogPreparationState === 'checking' &&
    product._id === request.productId &&
    product.catalogPreparationPolicy === CATALOG_PREPARATION_POLICY &&
    request.policyVersion === CATALOG_PREPARATION_POLICY &&
    request.contentGeneration === (product.catalogContentGeneration ?? 0)
    ? request
    : null;
}

export const CatalogReadinessSchema = z.enum(['normal', 'issues', 'preparing', 'unchecked']);
export type CatalogReadiness = z.infer<typeof CatalogReadinessSchema>;
