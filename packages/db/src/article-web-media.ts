import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { firstArticleContentBlock } from '@vibelingan-channel/articles';
import { articleIdentity } from '@vibelingan-channel/articles/media';
import { parsePublishedArticle } from '@vibelingan-channel/articles/publication';
import type {
  ArticleStore,
  ArticleStoreTransaction,
} from '@vibelingan-channel/articles/transaction-store';
import { z } from 'zod';
import {
  ArticleResponsiveMediaDocumentSchema,
  ArticleWebMediaDocumentSchema,
  type ArticleWebMediaReady,
  ArticleWebMediaReadySchema,
  articleWebMediaObjectInput,
  assertArticleWebMediaSource,
} from '../../articles/src/web-media.ts';
import { objectStoragePath } from '../../media-storage/src/index.ts';

/** One sidecar read; a missing record is allowed, but malformed data or SDK failures are not hidden. */
export async function readArticleWebMedia(store: Pick<ArticleStore, 'read'>, articleId: string) {
  articleIdentity.parse(articleId);
  const raw = await store.read('articleWebMedia', articleId);
  if (raw === null) return null;
  const value = ArticleWebMediaDocumentSchema.parse(document(raw, articleId));
  if (value.articleId !== articleId) throw Error('Article web media identity mismatch');
  for (const entry of Object.values(value.media)) assertStoragePath(entry);
  return value;
}

/** Upload and byte verification happen before this call, never inside the transaction. */
export async function registerArticleWebMedia(
  transaction: ArticleStoreTransaction,
  input: unknown,
): Promise<'registered' | 'unchanged'> {
  const entry = ArticleWebMediaReadySchema.parse(input);
  assertStoragePath(entry);
  return transaction(async (store) => {
    const raw = await store.read('articleMedia', entry.source.mediaId);
    if (raw === null) throw Error('Article web image original is missing');
    assertArticleWebMediaSource(entry, document(raw, entry.source.mediaId));
    const current = await readArticleWebMedia(store, entry.source.articleId);
    const previous =
      current && Object.hasOwn(current.media, entry.source.mediaId)
        ? current.media[entry.source.mediaId]
        : undefined;
    if (previous) {
      if (isDeepStrictEqual(previous, entry)) return 'unchanged';
      throw Error('An existing ready article web image must not be replaced');
    }
    const next = ArticleWebMediaDocumentSchema.parse({
      schemaVersion: 1,
      articleId: entry.source.articleId,
      media: { ...(current?.media ?? {}), [entry.source.mediaId]: entry },
    });
    await store.write('articleWebMedia', next.articleId, next);
    return 'registered';
  });
}
function responsiveKey(articleId: string) {
  // Starts with an underscore, outside the alphabet for the existing article IDs.
  return `_responsive_${createHash('sha256').update(articleIdentity.parse(articleId)).digest('hex')}`;
}

export async function readArticleResponsiveMedia(
  store: Pick<ArticleStore, 'read'>,
  articleId: string,
) {
  const key = responsiveKey(articleId);
  const raw = await store.read('articleWebMedia', key);
  if (raw === null) return null;
  const value = ArticleResponsiveMediaDocumentSchema.parse(document(raw, key));
  if (value.desktop.articleId !== articleId)
    throw Error('Responsive article media identity mismatch');
  for (const entry of [...Object.values(value.desktop.media), ...Object.values(value.mobile)])
    assertStoragePath(entry);
  return value;
}

export async function registerArticleResponsiveMedia(
  transaction: ArticleStoreTransaction,
  input: unknown,
): Promise<'registered' | 'unchanged'> {
  const entry = ArticleWebMediaReadySchema.parse(input);
  assertStoragePath(entry);
  const { articleId, mediaId } = entry.source;
  return transaction(async (store) => {
    const raw = await store.read('articleMedia', mediaId);
    if (raw === null) throw Error('Article web image original is missing');
    assertArticleWebMediaSource(entry, document(raw, mediaId));
    const published = await store.read('articleAccepted', articleId);
    if (published === null) throw Error('Responsive image needs a published article');
    const article = parsePublishedArticle(document(published, articleId).publication);
    const front = firstArticleContentBlock(article.content.body);
    if (
      article.articleId !== articleId ||
      front?.type !== 'articleImage' ||
      front.attrs.mediaId !== mediaId ||
      !Object.hasOwn(article.media, mediaId) ||
      article.media[mediaId]?.sha256 !== entry.source.checksumSha256
    )
      throw Error('Responsive image is no longer the published first image');
    const desktop = await readArticleWebMedia(store, articleId);
    if (!desktop || !Object.keys(article.media).every((id) => Object.hasOwn(desktop.media, id)))
      throw Error('All original v1 article image records must be ready');
    const current = await readArticleResponsiveMedia(store, articleId);
    const previous =
      current && Object.hasOwn(current.mobile, mediaId) ? current.mobile[mediaId] : undefined;
    if (previous && !isDeepStrictEqual(previous, entry))
      throw Error('An existing responsive article image must not be replaced');
    const next = ArticleResponsiveMediaDocumentSchema.parse({
      schemaVersion: 2,
      desktop,
      mobile: { ...(current?.mobile ?? {}), [mediaId]: entry },
    });
    if (isDeepStrictEqual(current, next)) return 'unchanged';
    await store.write('articleWebMedia', responsiveKey(articleId), next);
    return 'registered';
  });
}
function document(raw: unknown, id: string) {
  const { _id, ...value } = z.record(z.unknown()).parse(raw);
  if (_id !== id) throw Error('Article media storage record identity mismatch');
  return value;
}
function assertStoragePath(entry: ArticleWebMediaReady) {
  const date = /^articles\/([0-9]{4})\/(0[1-9]|1[0-2])\//u.exec(entry.web.storagePath);
  if (!date?.[1] || !date[2]) throw Error('Article web image storage date is invalid');
  const expected = objectStoragePath({
    ...articleWebMediaObjectInput(entry.source, entry.web.checksumSha256),
    now: new Date(`${date[1]}-${date[2]}-01T00:00:00.000Z`),
  });
  if (entry.web.storagePath !== expected)
    throw Error('Article web image storage path differs from its immutable identity');
}
