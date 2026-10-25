import { z } from 'zod';
import { articlePageDataShape } from './publication.ts';

/** A public list never needs the document body, storage location or editor identity. */
export const ArticleSummarySchema = z
  .object({
    articleId: articlePageDataShape.articleId,
    revision: articlePageDataShape.revision,
    contentHash: articlePageDataShape.contentHash,
    publishedAt: articlePageDataShape.publishedAt,
    modifiedAt: articlePageDataShape.modifiedAt,
    content: articlePageDataShape.content
      .pick({
        title: true,
        slug: true,
        authorName: true,
        excerpt: true,
      })
      .extend({
        slug: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        title: z.string().trim().min(1).max(400),
        authorName: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;
export const ArticleListSchema = z
  .object({
    articles: z.array(ArticleSummarySchema).max(12),
    next: articlePageDataShape.articleId.nullable(),
  })
  .strict();
export type ArticleList = z.infer<typeof ArticleListSchema>;
export interface PublicArticles {
  list(after?: string): Promise<ArticleList>;
  get(slug: string): Promise<import('./publication.ts').PublishedArticle | null>;
  media(
    id: string,
    file: string,
  ): Promise<{
    body: string;
    mimeType: string;
  } | null>;
}
