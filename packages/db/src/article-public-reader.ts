import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ArticleMediaRecordSchema, articleIdentity } from '@vibelingan-channel/articles/media';
import {
  ArticleListSchema,
  type ArticleRenderTimings,
  type ArticleRenderWebV1,
  ArticleSummarySchema,
  type PublicArticles,
} from '@vibelingan-channel/articles/public-read';
import { articleMediaPath, parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import type { ArticleStore } from '@vibelingan-channel/articles/transaction-store';
import {
  assertArticleWebMediaSource,
  buildArticleWebPresentation,
} from '@vibelingan-channel/articles/web-media';
import { z } from 'zod';
import { type ArticleDatabase, articleTransaction } from './article-repository.ts';
import { readArticleWebMedia } from './article-web-media.ts';

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
  const webBytes = new Map<string, { body: string; expiresAt: number }>();
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
      if (file.startsWith('web-v1-')) {
        const sidecar = await readArticleWebMedia(store, image.articleId);
        const presentation = buildArticleWebPresentation(article, sidecar);
        const descriptor = Object.hasOwn(presentation.media, id)
          ? presentation.media[id]
          : undefined;
        if (!descriptor || descriptor.url !== `/media/articles/${id}/${file}`) return null;
        const registered =
          sidecar && Object.hasOwn(sidecar.media, id) ? sidecar.media[id] : undefined;
        if (!registered) return null;
        const ready = assertArticleWebMediaSource(registered, image);
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
    getRender: async (slug, onTiming): Promise<ArticleRenderWebV1 | null> => {
      if (!validSlug(slug)) return null;
      const started = performance.now();
      const result = await transaction(async (store) => {
        const timings: Omit<ArticleRenderTimings, 'totalMs'> = { slugMs: 0, publicationMs: 0 };
        const article = await bySlug(store, slug, timings);
        if (!article) return null;
        const hasMedia = Object.keys(article.media).length > 0;
        const mediaStarted = performance.now();
        const sidecar = hasMedia ? await readArticleWebMedia(store, article.articleId) : null;
        if (hasMedia) timings.webMediaMs = performance.now() - mediaStarted;
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
      if (
        !articleIdentity.safeParse(id).success ||
        !/^(?:[a-f0-9]{64}\.(?:jpg|png|webp)|web-v1-[a-f0-9]{64}\.webp)$/.test(file)
      )
        return null;
      const started = performance.now();
      const ref = await mediaReference(id, file);
      const referenceBeforeMs = performance.now() - started;
      if (!ref) return null;
      const key =
        file.startsWith('web-v1-') && ref.byteSize <= webByteLimit
          ? JSON.stringify([ref.storageFileId, ref.sha256, ref.byteSize])
          : null;
      let cached = key === null ? undefined : webBytes.get(key);
      if (key !== null && cached && cached.expiresAt <= Date.now()) {
        webBytes.delete(key);
        cached = undefined;
      }
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
      // A withdrawal while storage was reading must not release private bytes.
      const referenceAfterStarted = performance.now();
      const current = await mediaReference(id, file);
      if (!current || !isDeepStrictEqual(current.authorization, ref.authorization)) return null;
      const referenceAfterMs = performance.now() - referenceAfterStarted;
      if (key !== null && !cached) {
        if (!webBytes.has(key) && webBytes.size === webByteEntries) {
          const oldest = webBytes.keys().next();
          if (!oldest.done) webBytes.delete(oldest.value);
        }
        webBytes.set(key, { body: result.body, expiresAt: Date.now() + webByteLifetimeMs });
      }
      return {
        body: result.body,
        mimeType: ref.mimeType,
        ...(options?.measure
          ? {
              timings: {
                referenceBeforeMs,
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
