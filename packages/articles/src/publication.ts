import { z } from 'zod';
import { ArticleContentSchema } from './article.ts';
import { articleContentHash, parsePublicationContent } from './drafts.ts';
import { articleImageIds } from './media.ts';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });
const mediaSchema = z
  .object({
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    sha256: hash,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(3 * 1024 * 1024),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
  })
  .strict()
  .refine((media) => media.width * media.height <= 32_000_000);
export type PublishedArticleMedia = z.infer<typeof mediaSchema>;
const publicationSchema = z
  .object({
    status: z.literal('accepted'),
    deliveryId: identity,
    articleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
    revision: z.number().int().positive().safe(),
    contentHash: hash,
    content: ArticleContentSchema,
    publishedAt: timestamp,
    modifiedAt: timestamp,
    acceptedAt: timestamp,
    media: z.record(identity, mediaSchema),
  })
  .strict();
export type PublishedArticle = z.infer<typeof publicationSchema>;

/** Consumes the publisher's explicit public projection, never a draft or database row. */
export function parsePublishedArticle(input: unknown): PublishedArticle {
  const value = publicationSchema.parse(input);
  const content = parsePublicationContent(value.content);
  if (articleContentHash(content) !== value.contentHash)
    throw new Error('Article content hash mismatch');
  if (value.publishedAt > value.modifiedAt || value.modifiedAt > value.acceptedAt)
    throw new Error('Article publication dates are out of order');
  const images = new Set(articleImageIds(content.body));
  if (
    images.size > 20 ||
    images.size !== Object.keys(value.media).length ||
    [...images].some((id) => !Object.hasOwn(value.media, id))
  )
    throw new Error('Article public media map must match the body exactly');
  return { ...value, content };
}

export function articleMediaPath(mediaId: string, input: unknown): string {
  const id = identity.parse(mediaId);
  const media = mediaSchema.parse(input);
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[
    media.mimeType
  ];
  return `/media/articles/${id}/${media.sha256}.${extension}`;
}
