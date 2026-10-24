import { z } from 'zod';
import { PRODUCT_FAMILY_OPTIONS } from './catalog-product.ts';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
export const CategoryApplySchema = z
  .object({
    kind: z.literal('apply'),
    productId: id,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime(),
    operationId: z.string().uuid(),
  })
  .strict();
export const CategoryApiRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('configure'), offset: z.number().int().min(0).max(100).default(0) })
    .strict(),
  z.object({ kind: z.literal('preview'), after: id.optional() }).strict(),
  z
    .object({ kind: z.literal('apply'), commands: z.array(CategoryApplySchema).min(1).max(10) })
    .strict(),
]);
export const CategoryPreviewRowSchema = z
  .object({
    productId: id,
    name: z.string(),
    sourceCategoryId: z.string(),
    target: z.enum(PRODUCT_FAMILY_OPTIONS).nullable(),
    status: z.enum(['ready', 'protected', 'deferred', 'rule-conflict']),
    command: CategoryApplySchema.omit({ operationId: true }).optional(),
  })
  .strict()
  .refine(
    (row) =>
      (row.status === 'ready') === (row.command !== undefined) &&
      (row.status !== 'ready' || row.target !== null),
  );
export const CategoryApiResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('configure'),
    nextOffset: z.number().int().nullable(),
    results: z.array(
      z.object({
        id,
        status: z.enum(['configured', 'conflict', 'failed', 'forbidden', 'invalid', 'missing']),
      }),
    ),
  }),
  z.object({
    kind: z.literal('preview'),
    nextAfter: id.nullable(),
    rows: z.array(CategoryPreviewRowSchema).max(100),
  }),
  z.object({
    kind: z.literal('apply'),
    results: z
      .array(
        z.object({
          id,
          status: z.enum([
            'applied',
            'replayed',
            'conflict',
            'failed',
            'forbidden',
            'invalid',
            'missing',
            'configured',
          ]),
        }),
      )
      .max(10),
  }),
]);
export type CategoryApiRequest = z.input<typeof CategoryApiRequestSchema>;
export type CategoryPreviewRow = z.infer<typeof CategoryPreviewRowSchema>;
export type CategoryApply = z.infer<typeof CategoryApplySchema>;
