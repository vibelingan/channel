import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  emptyCatalogImageReferenceCount,
  list,
} from '@vibelingan-channel/db';
import {
  hasCompleteCatalogWebVariants,
  readCatalogWebImageAtWidth,
} from '@vibelingan-channel/db/catalog-web-image';
import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';

/** Optional hints must not make a previously valid business response exceed its byte cap. */
export function budgetImagePresentation(
  map: CatalogImagePresentation,
  maximumBytes: number,
): CatalogImagePresentation {
  const selected: CatalogImagePresentation = {};
  let bytes = 2;
  for (const [source, candidates] of Object.entries(map)) {
    const extra =
      Buffer.byteLength(JSON.stringify(source)) +
      1 +
      Buffer.byteLength(JSON.stringify(candidates)) +
      (bytes > 2 ? 1 : 0);
    if (bytes + extra > maximumBytes) continue;
    selected[source] = candidates;
    bytes += extra;
  }
  return selected;
}

/** Called only after the product/detail has passed its ordinary public projection. */
export async function publicImagePresentation(
  sources: readonly string[],
  read = list,
): Promise<CatalogImagePresentation> {
  const urls = [...new Set(sources)].filter((source) =>
    /^(?:https:\/\/[^/?#]+)?\/api\/images\/[A-Za-z0-9_-]+$/.test(source),
  );
  const ids = [...new Set(urls.map((url) => url.slice(url.lastIndexOf('/') + 1)))];
  const byId = new Map<string, CatalogImagePresentation[string]>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const group = ids.slice(offset, offset + 100);
    let rows: Awaited<ReturnType<typeof read>>;
    try {
      rows = await read({
        collection: 'images',
        page: 1,
        pageSize: group.length,
        sort: [{ field: '_id', dir: 'asc' }],
        filter: {
          combinator: 'and',
          clauses: [
            { field: '_id', op: 'in', value: group },
            { field: 'storageProvider', op: 'in', value: ['cloudbase-storage', 'local-disk'] },
            { field: 'status', op: 'eq', value: 'active' },
          ],
        },
      });
    } catch (error) {
      const value = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      const code =
        typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'UNAVAILABLE';
      console.warn('[public-api] optional image sizes unavailable; keeping default URLs', { code });
      return {};
    }
    for (const image of rows.items) {
      if (!group.includes(image._id) || !hasCompleteCatalogWebVariants(image)) continue;
      let count = image.publishedRefCount;
      if (Object.hasOwn(image, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD)) {
        try {
          count = emptyCatalogImageReferenceCount(image);
        } catch {
          continue;
        }
      }
      // Pending reference work is resolved by the byte route, never N extra reads here.
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) continue;
      const candidates: CatalogImagePresentation[string] = [];
      for (const requested of [160, 640, 1280] as const) {
        const web = readCatalogWebImageAtWidth(image, requested);
        if (!web || candidates.some((candidate) => candidate.width === web.width)) continue;
        candidates.push({ url: `?w=${requested}`, width: web.width, height: web.height });
      }
      byId.set(image._id, candidates);
    }
  }
  return Object.fromEntries(
    urls.flatMap((source) => {
      const candidates = byId.get(source.slice(source.lastIndexOf('/') + 1));
      return candidates?.length
        ? [
            [
              source,
              candidates.map((candidate) => ({ ...candidate, url: `${source}${candidate.url}` })),
            ],
          ]
        : [];
    }),
  );
}

export async function presentCatalogImages<T extends Record<string, unknown>>(
  items: T[],
): Promise<T[]> {
  const sources = items.map((item) =>
    Array.isArray(item.images)
      ? item.images.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const all = await publicImagePresentation(sources.flat());
  // Reserve envelope space; hints may be omitted, business fields may not.
  let available = 2 * 1024 * 1024 - 512 - Buffer.byteLength(JSON.stringify(items));
  return items.map((item, index) => {
    const imagePresentation = budgetImagePresentation(
      Object.fromEntries(
        (sources[index] ?? []).flatMap((source) => (all[source] ? [[source, all[source]]] : [])),
      ),
      available - Buffer.byteLength(',"imagePresentation":'),
    );
    if (!Object.keys(imagePresentation).length) return item;
    available -=
      Buffer.byteLength(',"imagePresentation":') +
      Buffer.byteLength(JSON.stringify(imagePresentation));
    return { ...item, imagePresentation };
  });
}
