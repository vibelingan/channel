/** Bounded private check results. They describe saved inputs and never authorize publication. */
import { z } from 'zod';
import { CatalogIssueSchema } from './issues.ts';

export const CATALOG_PREPARATION_POLICY = 'catalog-preparation-v1';
const issues = z.array(CatalogIssueSchema).max(50);
const warnings = issues.refine((items) => items.every((issue) => issue.severity === 'warning'));
const base = z.object({
  schemaVersion: z.literal('catalog-preparation-report-v1'),
  productId: z.string().trim().min(1).max(200),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.string().trim().min(1).max(100),
  contentGeneration: z.number().int().nonnegative().safe(),
  checkedAt: z.string().datetime(),
});
export const CatalogPreparationReportSchema = z.discriminatedUnion('state', [
  base
    .extend({
      state: z.literal('ready'),
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
