/** Explicit future preparation only. Importing this module never calls CloudBase. */
import { ensureNoSqlResourceSet } from './cloudbase-nosql-resources.mjs';

export const ARTICLE_NOSQL_RESOURCES = Object.freeze(
  ['articleDrafts', 'articlePublications', 'articleSlugs', 'articleMedia'].map((collectionName) =>
    Object.freeze({
      collectionName,
      permission: 'ADMINONLY',
      indexes: Object.freeze([]),
    }),
  ),
);

/** Call only through a separately authorized, explicitly bound CloudBase tool client. */
export function ensureArticleNoSqlResources(callTool, log = console.log) {
  return ensureNoSqlResourceSet(callTool, ARTICLE_NOSQL_RESOURCES, log);
}
