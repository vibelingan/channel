import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ARTICLE_IMAGE_MAX_BYTES, ArticleMediaRecordSchema, articleIdentity } from './media.ts';
import { type PublishedArticle, articleMediaPath } from './publication.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mediaId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const storagePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.startsWith('articles/') &&
      !/[\\?#]/u.test(value) &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
  );
const fileId = z.string().min(1).max(2048);
const sourceSchema = z
  .object({
    mediaId,
    articleId: articleIdentity,
    checksumSha256: hash,
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byteSize: z.number().int().positive().safe().max(ARTICLE_IMAGE_MAX_BYTES),
    width: z.number().int().positive().safe().max(16384),
    height: z.number().int().positive().safe().max(16384),
    storageFileId: fileId,
    storagePath,
  })
  .strict()
  .refine((value) => value.width * value.height <= 32_000_000 && location(value) !== null);
export type ArticleWebMediaSource = z.infer<typeof sourceSchema>;
const webSchema = z
  .object({
    storageProvider: z.enum(['cloudbase-storage', 'local-disk']),
    storageFileId: fileId,
    storagePath,
    mimeType: z.literal('image/webp'),
    byteSize: z.number().int().min(1).safe().max(3_000_000),
    width: z.number().int().min(1).safe().max(1280),
    height: z.number().int().min(1).safe().max(16383),
    checksumSha256: hash,
  })
  .strict();

export const ArticleWebMediaReadySchema = z
  .object({
    status: z.literal('ready'),
    policyVersion: z.literal('article-web-v1'),
    sourceDigest: hash,
    source: sourceSchema,
    web: webSchema,
  })
  .strict()
  .refine((entry) => {
    const original = location(entry.source);
    const web = location(entry.web);
    return (
      entry.sourceDigest === articleWebMediaSourceDigest(entry.source) &&
      original !== null &&
      web !== null &&
      original.provider === web.provider &&
      original.bucket === web.bucket &&
      entry.web.storageProvider === web.provider &&
      entry.source.storagePath !== entry.web.storagePath
    );
  });
export type ArticleWebMediaReady = z.infer<typeof ArticleWebMediaReadySchema>;
export const ArticleWebMediaDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    articleId: articleIdentity,
    media: z.record(mediaId, ArticleWebMediaReadySchema),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.media).length <= 20 &&
      Object.entries(value.media).every(
        ([id, entry]) => entry.source.articleId === value.articleId && entry.source.mediaId === id,
      ),
  );
export type ArticleWebMediaDocument = z.infer<typeof ArticleWebMediaDocumentSchema>;

export const articleMobileWidth = 768;
export const ArticleResponsiveMediaDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    desktop: ArticleWebMediaDocumentSchema,
    mobile: z.record(mediaId, ArticleWebMediaReadySchema),
  })
  .strict()
  .refine(
    ({ desktop, mobile }) =>
      Object.keys(mobile).length <= 20 &&
      Object.entries(mobile).every(([id, compact]) => {
        const standard = Object.hasOwn(desktop.media, id) ? desktop.media[id] : undefined;
        return (
          standard !== undefined &&
          compact.source.mediaId === id &&
          compact.sourceDigest === standard.sourceDigest &&
          compact.web.width === articleMobileWidth &&
          compact.web.width < standard.web.width &&
          Math.abs(
            compact.web.height -
              Math.round((standard.web.height * compact.web.width) / standard.web.width),
          ) <= 1 &&
          compact.web.byteSize < standard.web.byteSize
        );
      }),
  );
export type ArticleResponsiveMediaDocument = z.infer<typeof ArticleResponsiveMediaDocumentSchema>;

const descriptorSchema = z
  .object({
    sourceSha256: hash,
    url: z
      .string()
      .max(512)
      .regex(/^\/media\/articles\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/web-v1-[a-f0-9]{64}\.webp$/),
    mimeType: z.literal('image/webp'),
    width: webSchema.shape.width,
    height: webSchema.shape.height,
    byteSize: webSchema.shape.byteSize,
    sha256: hash,
  })
  .strict();
export const ArticleWebPresentationSchema = z
  .object({
    media: z.record(mediaId, descriptorSchema),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value.media).length <= 20 &&
      Object.entries(value.media).every(
        ([id, descriptor]) => descriptor.url === articleWebMediaPath(id, descriptor.sha256),
      ),
  );
export type ArticleWebPresentation = z.infer<typeof ArticleWebPresentationSchema>;
export type ArticleWebPresentationArticle = Pick<PublishedArticle, 'articleId' | 'media'>;

export const ArticleMobileWebPresentationSchema = z
  .object({
    mediaId,
    sourceSha256: hash,
    url: z.string().max(512),
    width: z.literal(articleMobileWidth),
    sha256: hash,
  })
  .strict();
export type ArticleMobileWebPresentation = z.infer<typeof ArticleMobileWebPresentationSchema>;

export const publicArticleMediaFile =
  /^(?:[a-f0-9]{64}\.(?:jpg|png|webp)|web-v[12]-[a-f0-9]{64}\.webp)$/;

export function articleMobileMediaPath(id: string, checksum: string): string {
  return `/media/articles/${mediaId.parse(id)}/web-v2-${hash.parse(checksum)}.webp`;
}

export function parseArticleMobileWebPresentation(
  article: ArticleWebPresentationArticle,
  desktop: ArticleWebPresentation,
  input: unknown,
): ArticleMobileWebPresentation {
  const mobile = ArticleMobileWebPresentationSchema.parse(input);
  const standard = Object.hasOwn(desktop.media, mobile.mediaId)
    ? desktop.media[mobile.mediaId]
    : undefined;
  const original = Object.hasOwn(article.media, mobile.mediaId)
    ? article.media[mobile.mediaId]
    : undefined;
  if (
    !original ||
    !standard ||
    original.sha256 !== mobile.sourceSha256 ||
    standard.width <= mobile.width ||
    mobile.url !== articleMobileMediaPath(mobile.mediaId, mobile.sha256)
  )
    throw Error('Article mobile image differs from the published source');
  return mobile;
}

/** Only original file facts enter the digest; editing text, alt or dates does not replace a file. */
export function articleWebMediaSource(input: unknown): ArticleWebMediaSource {
  const image = ArticleMediaRecordSchema.parse(input);
  if (image.status !== 'active') throw Error('An active original article image is required');
  return sourceSchema.parse({
    mediaId: image.id,
    articleId: image.articleId,
    checksumSha256: image.checksumSha256,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    width: image.width,
    height: image.height,
    storageFileId: image.storage.storageFileId,
    storagePath: image.storage.storagePath,
  });
}
export function articleWebMediaSourceDigest(input: unknown): string {
  const value = sourceSchema.parse(input);
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.mediaId,
        value.articleId,
        value.checksumSha256,
        value.mimeType,
        value.byteSize,
        value.width,
        value.height,
        value.storageFileId,
        value.storagePath,
      ]),
    )
    .digest('hex');
}

/** Feed this identity to the existing storage facade; the facade owns its dated path. */
export function articleWebMediaObjectInput(input: unknown, outputSha256: string) {
  const source = sourceSchema.parse(input);
  const checksum = hash.parse(outputSha256);
  const logicalId = createHash('sha256')
    .update(
      JSON.stringify(['article-web-v1', source.articleId, source.mediaId, source.checksumSha256]),
    )
    .digest('hex');
  return { namespace: 'articles' as const, logicalId, fileName: `${checksum}.webp` };
}
export function assertArticleWebMediaSource(input: unknown, active: unknown): ArticleWebMediaReady {
  const entry = ArticleWebMediaReadySchema.parse(input);
  if (!isDeepStrictEqual(entry.source, articleWebMediaSource(active)))
    throw Error('Article web image original changed');
  return entry;
}
export function articleWebMediaPath(id: string, checksum: string): string {
  return `/media/articles/${mediaId.parse(id)}/web-v1-${hash.parse(checksum)}.webp`;
}

/** A removed image may keep its private ready entry, but must disappear from the public map. */
export function buildArticleWebPresentation(
  article: ArticleWebPresentationArticle,
  input: unknown,
): ArticleWebPresentation {
  articleIdentity.parse(article.articleId);
  if (input === null) return { media: {} };
  const sidecar = ArticleWebMediaDocumentSchema.parse(input);
  if (sidecar.articleId !== article.articleId)
    throw Error('Article web media belongs to another article');
  const entries: [string, ArticleWebPresentation['media'][string]][] = [];
  for (const [id, original] of Object.entries(article.media)) {
    const entry = Object.hasOwn(sidecar.media, id) ? sidecar.media[id] : undefined;
    if (!entry) continue;
    articleMediaPath(id, original);
    if (
      !isDeepStrictEqual(
        {
          mimeType: entry.source.mimeType,
          sha256: entry.source.checksumSha256,
          byteSize: entry.source.byteSize,
          width: entry.source.width,
          height: entry.source.height,
        },
        original,
      )
    )
      throw Error('Article web image does not match the published original');
    entries.push([
      id,
      {
        sourceSha256: original.sha256,
        url: articleWebMediaPath(id, entry.web.checksumSha256),
        mimeType: entry.web.mimeType,
        width: entry.web.width,
        height: entry.web.height,
        byteSize: entry.web.byteSize,
        sha256: entry.web.checksumSha256,
      },
    ]);
  }
  return parseArticleWebPresentation(article, { media: Object.fromEntries(entries) });
}
export function parseArticleWebPresentation(
  article: ArticleWebPresentationArticle,
  input: unknown,
): ArticleWebPresentation {
  articleIdentity.parse(article.articleId);
  const value = ArticleWebPresentationSchema.parse(input);
  for (const [id, descriptor] of Object.entries(value.media)) {
    const original = Object.hasOwn(article.media, id) ? article.media[id] : undefined;
    if (!original) throw Error('Article presentation contains an unreferenced image');
    articleMediaPath(id, original);
    if (
      descriptor.sourceSha256 !== original.sha256 ||
      descriptor.url !== articleWebMediaPath(id, descriptor.sha256)
    )
      throw Error('Article presentation source or URL differs');
  }
  return value;
}
function location(value: { storagePath: string; storageFileId: string }) {
  if (value.storageFileId === `local-disk:${value.storagePath}`)
    return { provider: 'local-disk', bucket: null };
  const match = /^cloud:\/\/([^/\s?#\\]+)\/(.+)$/u.exec(value.storageFileId);
  return match?.[1] && match[2] === value.storagePath
    ? { provider: 'cloudbase-storage', bucket: match[1] }
    : null;
}
