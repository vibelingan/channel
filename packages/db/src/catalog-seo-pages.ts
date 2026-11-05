import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { CatalogSeoPageSchema } from './catalog-seo-control.ts';
import { CatalogSeoRecordingConfigSchema } from './catalog-seo-requests.ts';
import { sdkAnswer } from './cloudbase-sdk-answer.ts';
export interface CatalogSeoPageReader {
  siteOrigin: string;
  read(productIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
}
interface PageQuery {
  limit(count: number): PageQuery;
  get(): Promise<unknown>;
}
export interface CatalogSeoPageDatabase {
  command: { in(values: string[]): unknown };
  collection(name: string): { where(filter: Record<string, unknown>): PageQuery };
}
export function readCatalogSeoPageOrigin(
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.CATALOG_SEO_PAGE_READINESS === undefined || env.CATALOG_SEO_PAGE_READINESS === '0')
    return undefined;
  if (env.CATALOG_SEO_PAGE_READINESS !== '1') throw Error('Invalid CATALOG_SEO_PAGE_READINESS');
  const site = CatalogSeoRecordingConfigSchema.shape.siteOrigin.parse(env.CATALOG_SEO_SITE_ORIGIN);
  if (env.SITE_URL !== undefined && env.SITE_URL !== site)
    throw Error('Catalog page site does not match SITE_URL');
  return site;
}
/** The returned map contains availability only; never send receipts or task data to clients. */
export function createCatalogSeoPageReader(
  site: string,
  readRows: (recordIds: string[]) => Promise<CollectionDoc[]>,
): CatalogSeoPageReader {
  const siteOrigin = CatalogSeoRecordingConfigSchema.shape.siteOrigin.parse(site);
  return {
    siteOrigin,
    read: async (ids) => {
      if (ids.length > 48 || new Set(ids).size !== ids.length)
        throw Error('Invalid page availability batch');
      const result = new Map<string, boolean>(ids.map((id) => [id, false]));
      if (!ids.length) return result;
      const expected = new Map(ids.map((id) => [catalogPublicRecordId(siteOrigin, id), id]));
      const rows = await readRows([...expected.keys()]);
      if (rows.length > ids.length || new Set(rows.map((row) => row._id)).size !== rows.length)
        throw Error('Invalid page availability identities');
      for (const row of rows) {
        const parsed = CatalogSeoPageSchema.safeParse(row);
        if (!parsed.success) continue;
        const page = parsed.data;
        if (page.siteOrigin === siteOrigin && expected.get(page._id) === page.productId)
          result.set(page.productId, page.ready === true);
      }
      return result;
    },
  };
}
export function createCloudCatalogSeoPageReader(
  db: CatalogSeoPageDatabase,
  siteOrigin: string,
): CatalogSeoPageReader {
  return createCatalogSeoPageReader(siteOrigin, async (ids) => {
    const response = sdkAnswer(
      await db
        .collection('catalogSeoPages')
        .where({ _id: db.command.in(ids) })
        .limit(ids.length)
        .get(),
    );
    if (!response || typeof response !== 'object' || !Array.isArray(Reflect.get(response, 'data')))
      throw Error('Invalid page availability response');
    const rows: unknown[] = Reflect.get(response, 'data');
    return rows.flatMap((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof Reflect.get(value, '_id') !== 'string'
      )
        return [];
      return [{ ...value, _id: String(Reflect.get(value, '_id')) }];
    });
  });
}
