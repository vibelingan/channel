/** Bounded browser status; the private operation root is never a response DTO. */
import { z } from 'zod';
export const CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES = 256 * 1024;
export const CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES = 4096;
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative().safe();
const base = z
  .object({
    ok: z.literal(true),
    kind: z.literal('product-operation'),
    productId: id,
    operationId: z.string().uuid(),
    intent: z.enum(['save-draft', 'refresh-live', 'publish', 'unpublish', 'archive']),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    current: z.boolean(),
    revisionCurrent: z.boolean(),
    expired: z.boolean(),
    cancelledAt: z.string().datetime().optional(),
  })
  .strict();
export const CatalogProductOperationBindingSchema = base.pick({
  productId: true,
  operationId: true,
  inputDigest: true,
});
export type CatalogProductOperationBinding = z.infer<typeof CatalogProductOperationBindingSchema>;
const saved = z
  .object({ at: z.string().datetime(), productUpdatedAt: z.string().datetime() })
  .strict();
const approval = z
  .object({
    revision: id,
    configurations: z.object({ completed: count.max(500), total: count.max(500) }).strict(),
    mediaReady: z.boolean(),
    references: z
      .object({ prepared: z.boolean(), staged: count.max(65536), total: count.max(65536) })
      .strict(),
  })
  .strict();
const reserved = base.extend({ state: z.literal('reserved') });
const savedStatus = base.extend({ state: z.literal('saved'), saved });
const staging = base.extend({ state: z.literal('staging'), saved, approval });
const complete = base.omit({ cancelledAt: true }).extend({
  state: z.literal('complete'),
  saved,
  approval,
  completion: z
    .object({
      at: z.string().datetime(),
      productUpdatedAt: z.string().datetime(),
      revision: id,
      published: z.literal(true),
    })
    .strict(),
});
export const CatalogProductOperationStatusSchema = z
  .discriminatedUnion('state', [reserved, savedStatus, staging, complete])
  .superRefine((status, ctx) => {
    if (status.state !== 'staging' && status.state !== 'complete') return;
    const { configurations, references } = status.approval;
    if (
      configurations.completed > configurations.total ||
      references.staged > references.total ||
      (!references.prepared && (references.staged !== 0 || references.total !== 0))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'Operation progress is inconsistent.',
      });
    if (
      status.state === 'complete' &&
      (!status.approval.mediaReady ||
        configurations.completed !== configurations.total ||
        !references.prepared ||
        references.staged !== references.total ||
        status.completion.revision !== status.approval.revision)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completion'],
        message: 'Completion must match the fully prepared approval.',
      });
  });
export type CatalogProductOperationStatus = z.infer<typeof CatalogProductOperationStatusSchema>;
