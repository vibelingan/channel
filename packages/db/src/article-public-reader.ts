import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { firstArticleContentBlock } from '@vibelingan-channel/articles';
import { ArticleMediaRecordSchema, articleIdentity } from '@vibelingan-channel/articles/media';
import {
  ArticleListSchema,
  type ArticleRenderTimings,
  type ArticleRenderWebV1,
  type ArticleRenderWebV2,
  ArticleSummarySchema,
  type PublicArticles,
} from '@vibelingan-channel/articles/public-read';
import { articleMediaPath, parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import type { ArticleStore } from '@vibelingan-channel/articles/transaction-store';
import {
  articleMobileMediaPath,
  articleMobileWidth,
  articleWebMediaPath,
  assertArticleWebMediaSource,
  buildArticleWebPresentation,
  publicArticleMediaFile,
} from '@vibelingan-channel/articles/web-media';
import { z } from 'zod';
import { type ArticleDatabase, articleTransaction } from './article-repository.ts';
import { readArticleResponsiveMedia, readArticleWebMedia } from './article-web-media.ts';

const webByteLimit = 256 * 1024;
const webByteEntries = 16;
const webByteLifetimeMs = 60_000;

async function row(store: ArticleStore, collection: string, id: string) {
  const raw = await store.read(collection, id);
  if (raw === null) return null;
  const { _id, ...value } = z.record(z.unknown()).parse(raw);
  if (_id !== id) throw Error('Public article record identity mismatch');
  return value;
}
async function accepted(
  store: ArticleStore,
  id: string,
  timings?: Pick<ArticleRenderTimings, 'publicationReadMs' | 'publicationValidationMs'>,
) {
  const started = timings ? performance.now() : 0;
  const value = await row(store, 'articleAccepted', id);
  if (!value || value.publication === null) return null;
  const readAt = timings ? performance.now() : 0;
  const article = parsePublishedArticle(value.publication);
  if (article.articleId !== id) throw Error('Public article identity mismatch');
  if (timings) {
    timings.publicationReadMs = readAt - started;
    timings.publicationValidationMs = performance.now() - readAt;
  }
  return article;
}
export function createCloudBasePublicArticles(
  db: ArticleDatabase,
  storage: {
    getObjectAsBase64(
      fileId: string,
      options: { maxBytes: number; timeoutMs: number; measure?: boolean },
    ): Promise<{ body: string; timings?: { lookupMs: number; downloadMs: number } }>;
  },
): PublicArticles {
  const transaction = articleTransaction(db);
  // Hold only verified, immutable bytes for this function instance. Authorization stays live.
  const webBytes = new Map<string, { body: string; expiresAt: number; storageFileId: string }>();
  const validSlug = (slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 200;
  async function bySlug(
    store: ArticleStore,
    slug: string,
    timings?: Omit<ArticleRenderTimings, 'totalMs' | 'webMediaMs'>,
  ) {
    const slugStarted = performance.now();
    const owner = await row(store, 'articleSlugs', slug);
    if (!owner) return null;
    const publicationStarted = performance.now();
    const article = await accepted(store, articleIdentity.parse(owner.articleId), timings);
    if (timings) {
      timings.slugMs = publicationStarted - slugStarted;
      timings.publicationMs = performance.now() - publicationStarted;
    }
    if (article && article.content.slug !== slug) throw Error('Public article URL mismatch');
    return article;
  }
  async function mediaReference(id: string, file: string) {
    return transaction(async (store) => {
      const raw = await row(store, 'articleMedia', id);
      if (!raw) return null;
      const image = ArticleMediaRecordSchema.parse(raw);
      if (image.id !== id || image.status !== 'active') return null;
      const article = await accepted(store, image.articleId);
      const media = article && Object.hasOwn(article.media, id) ? article.media[id] : undefined;
      if (!article || !media) return null;
      if (
        image.checksumSha256 !== media.sha256 ||
        image.byteSize !== media.byteSize ||
        image.mimeType !== media.mimeType ||
        image.width !== media.width ||
        image.height !== media.height
      )
        throw Error('Public article image metadata mismatch');
      const authorization = {
        articleId: article.articleId,
        revision: article.revision,
        contentHash: article.contentHash,
        media,
        source: {
          mediaId: image.id,
          articleId: image.articleId,
          checksumSha256: image.checksumSha256,
          mimeType: image.mimeType,
          byteSize: image.byteSize,
          width: image.width,
          height: image.height,
          storage: image.storage,
        },
      };
      if (file.startsWith('web-v')) {
        const mobile = file.startsWith('web-v2-');
        const record = mobile ? await readArticleResponsiveMedia(store, image.articleId) : null;
        const sidecar = mobile
          ? (record?.desktop ?? null)
          : await readArticleWebMedia(store, image.articleId);
        const registered = mobile ? record?.mobile : sidecar?.media;
        if (!registered || !Object.hasOwn(registered, id)) return null;
        if (!mobile) {
          const presentation = buildArticleWebPresentation(article, sidecar);
          if (!Object.hasOwn(presentation.media, id)) return null;
        }
        const ready = assertArticleWebMediaSource(registered[id], image);
        const expected = mobile
          ? articleMobileMediaPath(id, ready.web.checksumSha256)
          : articleWebMediaPath(id, ready.web.checksumSha256);
        if (expected !== `/media/articles/${id}/${file}`) return null;
        return {
          storageFileId: ready.web.storageFileId,
          byteSize: ready.web.byteSize,
          sha256: ready.web.checksumSha256,
          mimeType: ready.web.mimeType,
          authorization: { ...authorization, ready },
        };
      }
      if (articleMediaPath(id, media) !== `/media/articles/${id}/${file}`) return null;
      return {
        storageFileId: image.storage.storageFileId,
        byteSize: media.byteSize,
        sha256: media.sha256,
        mimeType: media.mimeType,
        authorization,
      };
    });
  }
  return {
    get: async (slug) => {
      if (!validSlug(slug)) return null;
      return transaction((store) => bySlug(store, slug));
    },
    getRender: async (
      slug,
      onTiming,
      responsive,
    ): Promise<ArticleRenderWebV1 | ArticleRenderWebV2 | null> => {
      if (!validSlug(slug)) return null;
      const started = performance.now();
      const result = await transaction(async (store) => {
        const timings: Omit<ArticleRenderTimings, 'totalMs'> = { slugMs: 0, publicationMs: 0 };
        const article = await bySlug(store, slug, timings);
        if (!article) return null;
        const ids = Object.keys(article.media);
        const mediaStarted = performance.now();
        const front =
          responsive && ids.length ? firstArticleContentBlock(article.content.body) : null;
        if (front?.type === 'articleImage') {
          // A failed optional registration must not take down an otherwise readable article.
          // Requests for the actual small bytes still fail closed in mediaReference.
          const record = await readArticleResponsiveMedia(store, article.articleId).catch(
            () => null,
          );
          const id = front.attrs.mediaId;
          const mobile = record && Object.hasOwn(record.mobile, id) ? record.mobile[id] : undefined;
          if (record && mobile && ids.every((id) => Object.hasOwn(record.desktop.media, id))) {
            const value: ArticleRenderWebV2 = {
              schemaVersion: 2,
              article,
              presentation: buildArticleWebPresentation(article, record.desktop),
              mobile: {
                mediaId: id,
                sourceSha256: mobile.source.checksumSha256,
                width: articleMobileWidth,
                url: articleMobileMediaPath(id, mobile.web.checksumSha256),
                sha256: mobile.web.checksumSha256,
              },
            };
            timings.webMediaMs = performance.now() - mediaStarted;
            return { value, timings };
          }
        }
        const sidecar = ids.length ? await readArticleWebMedia(store, article.articleId) : null;
        if (ids.length) timings.webMediaMs = performance.now() - mediaStarted;
        const value: ArticleRenderWebV1 = {
          schemaVersion: 1,
          article,
          presentation: buildArticleWebPresentation(article, sidecar),
        };
        return { value, timings };
      });
      if (!result) return null;
      onTiming?.({ ...result.timings, totalMs: performance.now() - started });
      return result.value;
    },
    list: async (after) => {
      if (after !== undefined) articleIdentity.parse(after);
      const query = db
        .collection('articleAccepted')
        .where({
          'publication.status': 'accepted',
          ...(after ? { _id: db.command.gt(after) } : {}),
        })
        .orderBy('_id', 'asc')
        .limit(13)
        .field({
          _id: true,
          'publication.articleId': true,
          'publication.revision': true,
          'publication.contentHash': true,
          'publication.publishedAt': true,
          'publication.modifiedAt': true,
          'publication.content.title': true,
          'publication.content.slug': true,
          'publication.content.authorName': true,
          'publication.content.excerpt': true,
        });
      const result = z
        .object({
          data: z.array(z.record(z.unknown())).max(13),
          code: z.union([z.literal(0), z.literal('')]).optional(),
        })
        .passthrough()
        .parse(await query.get());
      let previous = after ?? '';
      const all = result.data.map((value) => {
        const summary = ArticleSummarySchema.parse(value.publication);
        if (value._id !== summary.articleId || summary.articleId <= previous)
          throw Error('Public article pagination did not advance');
        previous = summary.articleId;
        return summary;
      });
      const articles = all.slice(0, 12);
      return ArticleListSchema.parse({
        articles,
        next: all.length > 12 ? articles.at(-1)?.articleId : null,
      });
    },
    media: async (id, file, options) => {
      if (!articleIdentity.safeParse(id).success || !publicArticleMediaFile.test(file)) return null;
      const started = performance.now();
      const key = file.startsWith('web-v') ? `${id}/${file}` : null;
      const candidate = key === null ? undefined : webBytes.get(key);
      // Read any in-memory candidate before checking the current public reference.
      const ref = await mediaReference(id, file);
      const referenceMs = performance.now() - started;
      if (!ref) return null;
      const cached =
        candidate &&
        candidate.expiresAt > Date.now() &&
        candidate.storageFileId === ref.storageFileId &&
        ref.byteSize <= webByteLimit
          ? candidate
          : undefined;
      const storageStarted = performance.now();
      const result = cached
        ? { body: cached.body }
        : await storage.getObjectAsBase64(ref.storageFileId, {
            maxBytes: ref.byteSize,
            timeoutMs: 10_000,
            ...(options?.measure ? { measure: true } : {}),
          });
      const storageMs = cached ? 0 : performance.now() - storageStarted;
      const validationStarted = performance.now();
      const bytes = Buffer.from(result.body, 'base64');
      if (
        bytes.toString('base64') !== result.body ||
        bytes.length !== ref.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== ref.sha256
      )
        throw Error('Public article image bytes mismatch');
      const validationMs = performance.now() - validationStarted;
      let referenceAfterMs = referenceMs;
      if (!cached) {
        // Recheck after the storage network request, which can overlap a withdrawal.
        const referenceAfterStarted = performance.now();
        const current = await mediaReference(id, file);
        if (!current || !isDeepStrictEqual(current.authorization, ref.authorization)) return null;
        referenceAfterMs = performance.now() - referenceAfterStarted;
        if (key !== null && ref.byteSize <= webByteLimit) {
          if (!webBytes.has(key) && webBytes.size === webByteEntries) {
            const oldest = webBytes.keys().next();
            if (!oldest.done) webBytes.delete(oldest.value);
          }
          webBytes.set(key, {
            body: result.body,
            expiresAt: Date.now() + webByteLifetimeMs,
            storageFileId: ref.storageFileId,
          });
        }
      }
      return {
        body: result.body,
        mimeType: ref.mimeType,
        ...(options?.measure
          ? {
              timings: {
                referenceBeforeMs: cached ? 0 : referenceMs,
                storageMs,
                validationMs,
                referenceAfterMs,
                totalMs: performance.now() - started,
                ...(result.timings
                  ? {
                      lookupMs: result.timings.lookupMs,
                      downloadMs: result.timings.downloadMs,
                    }
                  : {}),
              },
            }
          : {}),
      };
    },
  };
}
