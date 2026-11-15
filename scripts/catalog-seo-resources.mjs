import { ensureNoSqlResourceSet } from './cloudbase-nosql-resources.mjs';

/** Optional SEO collections are prepared explicitly before enabling the writers. */
export const CATALOG_SEO_NOSQL_RESOURCES = Object.freeze([
  ...['catalogSeoRequests', 'catalogSeoTasks'].map((collectionName) =>
    Object.freeze({
      collectionName,
      permission: 'ADMINONLY',
      indexes: Object.freeze([
        {
          IndexName:
            collectionName === 'catalogSeoRequests'
              ? 'catalog_seo_request_queue'
              : 'catalog_seo_task_queue',
          MgoKeySchema: {
            MgoIsUnique: false,
            MgoIndexKeys: [
              { Name: 'siteOrigin', Direction: '1' },
              { Name: 'state', Direction: '1' },
              { Name: '_id', Direction: '1' },
            ],
          },
        },
      ]),
    }),
  ),
  ...[
    'catalogPublicHeads',
    'catalogSeoPages',
    'catalogSeoControl',
    'catalogSeoBuilders',
    'catalogSeoWakeups',
    'catalogSeoArchives',
  ].map((collectionName) =>
    Object.freeze({
      collectionName,
      permission: 'ADMINONLY',
      indexes: Object.freeze([]),
    }),
  ),
]);

export function ensureCatalogSeoNoSqlResources(callTool, log = console.log) {
  return ensureNoSqlResourceSet(callTool, CATALOG_SEO_NOSQL_RESOURCES, log);
}
