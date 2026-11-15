import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ArticleMediaRecordSchema, articleIdentity } from '@vibelingan-channel/articles/media';
import {
  ArticleListSchema,
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

async function row(store: ArticleStore, collection: string, id: string) {
  const raw = await store.read(collection, id);
  if (raw === null) return null;
  const { _id, ...value } = z.record(z.unknown()).parse(raw);
  if (_id !== id) throw Error('Public article record identity mismatch');
  return value;
}
async function accepted(store: ArticleStore, id: string) {
  const value = await row(store, 'articleAccepted', id);
  if (!value || value.publication === null) return null;
  const article = parsePublishedArticle(value.publication);
  if (article.articleId !== id) throw Error('Public article identity mismatch');
  return article;
}
export function createCloudBasePublicArticles(
  db: ArticleDatabase,
  storage: {
    getObjectAsBase64(
      fileId: string,
      options: { maxBytes: number; timeoutMs: number },
    ): Promise<{ body: string }>;
  },
): PublicArticles {
  const transaction = articleTransaction(db);
  const validSlug = (slug: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 200;
  async function bySlug(store: ArticleStore, slug: string) {
    const owner = await row(store, 'articleSlugs', slug);
    if (!owner) return null;
    const article = await accepted(store, articleIdentity.parse(owner.articleId));
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
      const media = article?.media[id];
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
        const descriptor = presentation.media[id];
        if (!descriptor || descriptor.url !== `/media/articles/${id}/${file}`) return null;
        const registered = sidecar?.media[id];
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
    getRender: async (slug): Promise<ArticleRenderWebV1 | null> => {
      if (!validSlug(slug)) return null;
      return transaction(async (store) => {
        const article = await bySlug(store, slug);
        if (!article) return null;
        const sidecar = await readArticleWebMedia(store, article.articleId);
        return {
          schemaVersion: 1,
          article,
          presentation: buildArticleWebPresentation(article, sidecar),
        };
      });
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
    media: async (id, file) => {
      if (
        !articleIdentity.safeParse(id).success ||
        !/^(?:[a-f0-9]{64}\.(?:jpg|png|webp)|web-v1-[a-f0-9]{64}\.webp)$/.test(file)
      )
        return null;
      const ref = await mediaReference(id, file);
      if (!ref) return null;
      const result = await storage.getObjectAsBase64(ref.storageFileId, {
        maxBytes: ref.byteSize,
        timeoutMs: 10_000,
      });
      const bytes = Buffer.from(result.body, 'base64');
      if (
        bytes.toString('base64') !== result.body ||
        bytes.length !== ref.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== ref.sha256
      )
        throw Error('Public article image bytes mismatch');
      // A withdrawal while storage was reading must not release private bytes.
      const current = await mediaReference(id, file);
      if (!current || !isDeepStrictEqual(current.authorization, ref.authorization)) return null;
      return { body: result.body, mimeType: ref.mimeType };
    },
  };
}
