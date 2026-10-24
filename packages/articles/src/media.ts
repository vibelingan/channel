import { z } from 'zod';
import type { ArticleDocument, ArticleNode } from './document.ts';

export const ARTICLE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const ARTICLE_IMAGE_MAX_COUNT = 20;
export const ARTICLE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const articleIdentity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
export const ArticleImageFileSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    mimeType: z.enum(ARTICLE_IMAGE_MIMES),
    byteSize: z.number().int().positive().max(ARTICLE_IMAGE_MAX_BYTES),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ArticleImageFile = z.infer<typeof ArticleImageFileSchema>;
const storage = z
  .object({
    storageFileId: z.string().min(1).max(2048),
    storagePath: z.string().min(1).max(1024),
  })
  .strict();
const record = ArticleImageFileSchema.extend({
  id: articleIdentity,
  articleId: articleIdentity,
  purpose: z.literal('article-image'),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: articleIdentity,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  pendingStorage: storage,
});
export const ArticleMediaRecordSchema = z.discriminatedUnion('status', [
  record.extend({ status: z.literal('pending') }).strict(),
  record
    .extend({
      status: z.literal('active'),
      storage,
      width: z.number().int().min(1).max(16384),
      height: z.number().int().min(1).max(16384),
    })
    .strict(),
]);
export type ArticleMediaRecord = z.infer<typeof ArticleMediaRecordSchema>;
export type ActiveArticleMedia = Extract<ArticleMediaRecord, { status: 'active' }>;
export const ArticleMediaViewSchema = ArticleImageFileSchema.pick({
  mimeType: true,
  byteSize: true,
})
  .extend({
    mediaId: articleIdentity,
    articleId: articleIdentity,
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
  })
  .strict();
export type ArticleMediaView = z.infer<typeof ArticleMediaViewSchema>;
export function articleMediaView(value: ActiveArticleMedia): ArticleMediaView {
  return {
    mediaId: value.id,
    articleId: value.articleId,
    mimeType: value.mimeType,
    byteSize: value.byteSize,
    width: value.width,
    height: value.height,
  };
}

export function articleImageIds(body: ArticleDocument): string[] {
  const ids = new Set<string>();
  function visit(node: ArticleNode) {
    if (node.type === 'articleImage') ids.add(node.attrs.mediaId);
    else if ('content' in node) node.content.forEach(visit);
  }
  visit(body.document);
  return [...ids];
}

export type ArticleMediaCommand =
  | { operation: 'get'; mediaId: string }
  | { operation: 'reserve'; record: Extract<ArticleMediaRecord, { status: 'pending' }> }
  | { operation: 'activate'; record: ActiveArticleMedia };
export interface ArticleMediaRepository {
  execute(
    actorId: string,
    articleId: string,
    command: ArticleMediaCommand,
  ): Promise<ArticleMediaRecord | null>;
}
