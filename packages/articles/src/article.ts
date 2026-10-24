import { z } from 'zod';
import { ArticleDocumentSchema, readArticleInput } from './document.ts';

export const ArticleContentSchema = z
  .object({
    title: z.string().trim().max(200),
    slug: z.string().trim().max(120),
    excerpt: z.string().trim().max(500).default(''),
    authorName: z.string().trim().max(120).default(''),
    seoTitle: z.string().trim().max(200).default(''),
    seoDescription: z.string().trim().max(320).default(''),
    body: ArticleDocumentSchema,
  })
  .strict();
export type ArticleContent = z.infer<typeof ArticleContentSchema>;
export function parseArticleContent(input: unknown): ArticleContent {
  return readArticleInput(ArticleContentSchema, input);
}
