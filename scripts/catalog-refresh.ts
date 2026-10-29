import { CatalogPublicHeadSchema } from '../packages/db/src/catalog-public-changes.ts';
import {
  type CatalogSeoStore,
  consumeCatalogSeoRequest,
} from '../packages/db/src/catalog-seo-consumer.ts';
import {
  catalogSeoControlId,
  readCatalogSeoControl,
} from '../packages/db/src/catalog-seo-control.ts';
import { createCatalogSeoDelivery } from '../packages/db/src/catalog-seo-delivery.ts';
import {
  type CatalogSeoRecordingConfig,
  CatalogSeoRequestSchema,
} from '../packages/db/src/catalog-seo-requests.ts';

export async function prepareCatalogRefresh(
  store: CatalogSeoStore,
  config: CatalogSeoRecordingConfig,
  runId: string,
) {
  const now = () => new Date().toISOString();
  for (let round = 0; round < 100; round++) {
    const before = readCatalogSeoControl(
      await store.get('catalogSeoControl', catalogSeoControlId(config.siteOrigin)),
      config.siteOrigin,
      now(),
    );
    if (before.state !== 'idle') throw Error('Earlier catalog delivery needs readback');
    const pending = await store.list(
      'catalogSeoRequests',
      { siteOrigin: config.siteOrigin, state: 'pending' },
      null,
      100,
    );
    if (pending.length) {
      for (const row of pending)
        await consumeCatalogSeoRequest(store, CatalogSeoRequestSchema.parse(row), config, now());
      continue;
    }
    const after = readCatalogSeoControl(
      await store.get('catalogSeoControl', before._id),
      config.siteOrigin,
      now(),
    );
    if (after.writes !== before.writes || after.state !== 'idle') continue;
    const heads = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await store.list(
        'catalogPublicHeads',
        { siteOrigin: config.siteOrigin },
        cursor,
        100,
      );
      for (const row of page) {
        const head = CatalogPublicHeadSchema.parse(row);
        if (head.siteOrigin !== config.siteOrigin) throw Error('Wrong catalog site');
        heads.push(head);
        cursor = head._id;
      }
      if (page.length < 100) break;
      if (heads.length > 50000) throw Error('SEO head count exceeds bound');
    }
    return {
      writes: after.writes,
      heads,
      delivery: createCatalogSeoDelivery(store, config.siteOrigin, after.writes, runId),
    };
  }
  throw Error('Product changes did not settle within the bounded preparation window; retry later');
}

export { guardCatalogHostingAdapters } from './catalog-hosting-guard.mjs';
