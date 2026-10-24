/** Article resources stay module-owned; importing definitions never calls CloudBase. */
import { ensureNoSqlResourceSet } from './cloudbase-nosql-resources.mjs';

export const ARTICLE_NOSQL_RESOURCES = Object.freeze(
  [
    'articleDrafts',
    'articlePublications',
    'articleSlugs',
    'articleMedia',
    'articleReleaseTasks',
    'articleReleaseHeads',
    'articleAccepted',
  ].map((collectionName) =>
    Object.freeze({
      collectionName,
      permission: 'ADMINONLY',
      indexes: Object.freeze([]),
    }),
  ),
);

/** The normal deploy supplies its authenticated client after the hosting backup passes. */
export function ensureArticleNoSqlResources(callTool, log = console.log) {
  return ensureNoSqlResourceSet(callTool, ARTICLE_NOSQL_RESOURCES, log);
}
