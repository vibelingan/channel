import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicationApproval = z
  .object({
    decision: z.enum(['publish-now', 'withdraw-now']),
    messageRef: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(1000),
  })
  .strict();
export const publicationReceiptSchema = z
  .object({
    operationId: z.string().regex(/^article-import-[a-f0-9]{64}$/),
    articleId: z.string().regex(/^article-[a-f0-9]{64}$/),
    revision: z.number().int().positive().safe(),
    contentHash: hash,
    sourceHash: hash,
    state: z.enum(['ready', 'published', 'withdrawn']),
    publicUrl: z
      .string()
      .regex(/^https:\/\/supplychainsai\.com\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/)
      .nullable(),
    publishedRevision: z.number().int().positive().safe().nullable(),
    publishedContentHash: hash.nullable(),
    publishedModifiedAt: z.string().datetime().nullable(),
    canPublish: z.boolean(),
    replayed: z.boolean(),
    releaseId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)
      .nullable(),
  })
  .strict()
  .refine((r) =>
    r.state === 'published'
      ? r.publicUrl !== null &&
        r.publishedRevision !== null &&
        r.publishedContentHash !== null &&
        r.publishedModifiedAt !== null
      : r.publicUrl === null &&
        r.publishedRevision === null &&
        r.publishedContentHash === null &&
        r.publishedModifiedAt === null,
  );
