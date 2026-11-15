import { z } from 'zod';
export const draftInput = z
  .object({
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,128}$/)
      .describe('同一篇生成结果的稳定编号，重试不能更换。'),
    externalTaskId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    slug: z.string().max(120).optional(),
    excerpt: z.string().max(500).optional(),
    authorName: z.string().max(120).optional(),
    seoTitle: z.string().max(200).optional(),
    seoDescription: z.string().max(320).optional(),
    format: z.enum(['markdown', 'article-json-v1']),
    body: z.union([
      z.string().max(131072),
      z.object({ schemaVersion: z.literal(1), document: z.record(z.unknown()) }).strict(),
    ]),
  })
  .strict();
