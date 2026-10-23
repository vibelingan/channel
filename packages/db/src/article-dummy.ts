import type { ArticleDatabase } from './article-repository.ts';

/** Fixed test namespace; arbitrary prefixes and collection passthrough are forbidden. */
export const BLOG_DUMMY_COLLECTIONS = Object.freeze({
  users: 'blogDummy20261023Users',
  articleDrafts: 'blogDummy20261023Drafts',
  articleMedia: 'blogDummy20261023Media',
  articlePublications: 'blogDummy20261023Publications',
  articleSlugs: 'blogDummy20261023Slugs',
  articleReleaseTasks: 'blogDummy20261023Tasks',
  articleReleaseHeads: 'blogDummy20261023Heads',
  articleAccepted: 'blogDummy20261023Accepted',
});
export function blogDummyCollection(name: string): string {
  if (!Object.hasOwn(BLOG_DUMMY_COLLECTIONS, name))
    throw new Error('Collection is outside the Blog dummy scope');
  const mapped: unknown = Reflect.get(BLOG_DUMMY_COLLECTIONS, name);
  if (typeof mapped !== 'string') throw new Error('Invalid Blog dummy collection');
  return mapped;
}

/** Uses the real SDK transaction implementation with fixed isolated collection names. */
export function createBlogDummyDatabase(db: ArticleDatabase, envId: string): ArticleDatabase {
  const config: unknown = Reflect.get(db, 'config');
  if (!envId || !config || typeof config !== 'object' || Reflect.get(config, 'env') !== envId)
    throw new Error('Blog dummy database environment mismatch');
  return {
    command: db.command,
    RegExp: db.RegExp,
    collection: (name) => db.collection(blogDummyCollection(name)),
    runTransaction: (operation) =>
      db.runTransaction((transaction) =>
        operation({ collection: (name) => transaction.collection(blogDummyCollection(name)) }),
      ),
  };
}
