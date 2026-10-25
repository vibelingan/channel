import { createHash } from 'node:crypto';
import { ArticleMediaRecordSchema, articleIdentity } from '@vibelingan-channel/articles/media';
import {
  ArticleListSchema,
  ArticleSummarySchema,
  type PublicArticles,
} from '@vibelingan-channel/articles/public-read';
import { articleMediaPath, parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import type { ArticleStore } from '@vibelingan-channel/articles/transaction-store';
import { z } from 'zod';
import { type ArticleDatabase, articleTransaction } from './article-repository.ts';

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
  async function mediaReference(id: string, file: string) {
    return transaction(async (store) => {
      const raw = await row(store, 'articleMedia', id);
      if (!raw) return null;
      const image = ArticleMediaRecordSchema.parse(raw);
      if (image.id !== id || image.status !== 'active') return null;
      const article = await accepted(store, image.articleId);
      const media = article?.media[id];
      if (!media || articleMediaPath(id, media) !== `/media/articles/${id}/${file}`) return null;
      if (
        image.checksumSha256 !== media.sha256 ||
        image.byteSize !== media.byteSize ||
        image.mimeType !== media.mimeType ||
        image.width !== media.width ||
        image.height !== media.height
      )
        throw Error('Public article image metadata mismatch');
      return { image, media, contentHash: article.contentHash };
    });
  }
  return {
    get: async (slug) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 200) return null;
      return transaction(async (store) => {
        const owner = await row(store, 'articleSlugs', slug);
        if (!owner) return null;
        const article = await accepted(store, articleIdentity.parse(owner.articleId));
        if (article && article.content.slug !== slug) throw Error('Public article URL mismatch');
        return article;
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
      if (!articleIdentity.safeParse(id).success || !/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(file))
        return null;
      const ref = await mediaReference(id, file);
      if (!ref) return null;
      const result = await storage.getObjectAsBase64(ref.image.storage.storageFileId, {
        maxBytes: ref.media.byteSize,
        timeoutMs: 10_000,
      });
      const bytes = Buffer.from(result.body, 'base64');
      if (
        bytes.toString('base64') !== result.body ||
        bytes.length !== ref.media.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== ref.media.sha256
      )
        throw Error('Public article image bytes mismatch');
      // A withdrawal while storage was reading must not release private bytes.
      const current = await mediaReference(id, file);
      if (!current || current.contentHash !== ref.contentHash) return null;
      return { body: result.body, mimeType: ref.media.mimeType };
    },
  };
}
