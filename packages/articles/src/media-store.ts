import { z } from 'zod';
import { ArticleDraftError, parseArticleDraft } from './draft-repository.ts';
import {
  type ArticleMediaCommand,
  type ArticleMediaRecord,
  ArticleMediaRecordSchema,
  articleIdentity,
} from './media.ts';

export interface ArticleMediaStore {
  read(collection: string, id: string): Promise<unknown>;
  write(collection: string, id: string, value: Record<string, unknown>): Promise<void>;
}

/** Run inside the adapter's transaction, including the current account and owning draft reads. */
export async function runArticleMediaCommand(
  store: ArticleMediaStore,
  actorId: string,
  articleId: string,
  command: ArticleMediaCommand,
): Promise<ArticleMediaRecord | null> {
  articleIdentity.parse(actorId);
  articleIdentity.parse(articleId);
  const user = await store.read('users', actorId);
  if (!user || typeof user !== 'object' || Reflect.get(user, 'status') === 'suspended')
    throw new ArticleDraftError('UNAUTHORIZED', 'This session is no longer valid.');
  if (Reflect.get(user, '_id') !== actorId) throw new Error('Inconsistent article media account');
  if (Reflect.get(user, 'role') !== 'admin')
    throw new ArticleDraftError('FORBIDDEN', 'Admin permission is required.');
  const article = await store.read('articleDrafts', articleId);
  if (!article) throw new ArticleDraftError('NOT_FOUND', 'Article draft was not found.');
  if (
    typeof article !== 'object' ||
    Reflect.get(article, '_id') !== articleId ||
    parseArticleDraft(Reflect.get(article, 'draft')).id !== articleId
  )
    throw new Error('Inconsistent owning article');
  const id = articleIdentity.parse(
    command.operation === 'get' ? command.mediaId : command.record.id,
  );
  const raw = await store.read('articleMedia', id);
  let current: ArticleMediaRecord | null = null;
  if (raw !== null) {
    const { _id, ...body } = z.record(z.unknown()).parse(raw);
    if (_id !== id) throw new Error('Inconsistent media record');
    current = ArticleMediaRecordSchema.parse(body);
  }
  if (current && (current.articleId !== articleId || current.id !== id))
    throw new ArticleDraftError('NOT_FOUND', 'Article image was not found.');
  if (command.operation === 'get') return current;
  const next = ArticleMediaRecordSchema.parse(command.record);
  if (
    next.articleId !== articleId ||
    next.id !== id ||
    (command.operation === 'reserve' && next.createdBy !== actorId)
  )
    throw new ArticleDraftError('VALIDATION_ERROR', 'Invalid article image ownership.');
  if (command.operation === 'reserve') {
    if (current) {
      if (current.requestHash !== next.requestHash)
        throw new ArticleDraftError(
          'CONFLICT',
          'This image request was already used for a different file.',
        );
      return current;
    }
    if (next.status !== 'pending') throw new Error('Expected a pending image');
  } else {
    if (!current) throw new ArticleDraftError('NOT_FOUND', 'Article image was not found.');
    if (current.status === 'active') return current;
    if (
      next.status !== 'active' ||
      JSON.stringify({
        ...next,
        status: 'pending',
        storage: undefined,
        width: undefined,
        height: undefined,
      }) !== JSON.stringify(current)
    )
      throw new ArticleDraftError('CONFLICT', 'Article image changed during verification.');
    if (Date.parse(current.expiresAt) <= Date.now())
      throw new ArticleDraftError('CONFLICT', 'Image upload expired. Select the file again.');
  }
  await store.write('articleMedia', id, next);
  return next;
}
