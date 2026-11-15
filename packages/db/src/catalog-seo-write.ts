import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planCatalogSeoWrite, writeCatalogSeoPermit } from './catalog-seo-control.ts';
import {
  type CatalogSeoChange,
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
  catalogSeoRequests,
} from './catalog-seo-requests.ts';

export interface CatalogSeoWriteStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: string, row: CollectionDoc): Promise<void>;
  remove?(collection: string, id: string): Promise<void>;
  patch?(collection: string, id: string, fields: Record<string, unknown>): Promise<void>;
}
type OperationStore = CatalogSeoWriteStore & {
  remove(collection: string, id: string): Promise<void>;
};
let recording: CatalogSeoRecordingConfig | undefined;
export function configureCatalogSeoRecording(config: CatalogSeoRecordingConfig | undefined): void {
  recording =
    config === undefined ? undefined : Object.freeze(CatalogSeoRecordingConfigSchema.parse(config));
}
export function catalogSeoRecordingConfig(): CatalogSeoRecordingConfig | undefined {
  return recording;
}
const monitored = new Set(['products', 'productVariants', 'catalogTaxonomies']);

/** The caller owns one native transaction. Exceptions must escape to abort it. */
export async function recordCatalogSeoWrites<T>(
  base: CatalogSeoWriteStore,
  options: CatalogSeoRecordingConfig | undefined,
  operation: (store: OperationStore) => Promise<T>,
  settings: { now?: string; externalOperations?: number } = {},
): Promise<T> {
  const patch = base.patch?.bind(base);
  const remove = async (collection: string, id: string) => {
    if (!base.remove) throw new Error('This transaction does not support removal');
    await base.remove(collection, id);
  };
  if (options === undefined)
    return operation({
      get: (collection, id) => base.get(collection, id),
      set: (collection, row) => base.set(collection, row),
      remove,
      ...(patch
        ? {
            patch: (collection: string, id: string, fields: Record<string, unknown>) =>
              patch(collection, id, fields),
          }
        : {}),
    });
  const config = CatalogSeoRecordingConfigSchema.parse(options);
  if (
    !Number.isSafeInteger(settings.externalOperations ?? 0) ||
    (settings.externalOperations ?? 0) < 0 ||
    (settings.externalOperations ?? 0) > 100
  )
    throw new Error('Invalid reserved transaction operations');
  const before = new Map<string, CollectionDoc | null>();
  const after = new Map<string, CollectionDoc | null>();
  const writes: Array<() => Promise<void>> = [];
  const targets = new Map<string, { collection: string; id: string }>();
  let reads = settings.externalOperations ?? 0;
  let writing = false;
  const key = (collection: string, id: string) => JSON.stringify([collection, id]);
  const load = async (collection: string, id: string) => {
    const own = key(collection, id);
    if (!before.has(own)) {
      reads++;
      const value = await base.get(collection, id);
      if (value && value._id !== id) throw new Error('Catalog read changed document identity');
      before.set(own, structuredClone(value));
    }
    return structuredClone(before.get(own) ?? null);
  };
  const stage = (collection: string, id: string, value: CollectionDoc | null) => {
    writing = true;
    if (monitored.has(collection)) {
      const own = key(collection, id);
      targets.set(own, { collection, id });
      after.set(own, structuredClone(value));
    }
  };
  const store: OperationStore = {
    get: async (collection, id) => {
      if (writing) throw new Error('Read after staged transaction write');
      return load(collection, id);
    },
    set: async (collection, value) => {
      const copy = structuredClone(value);
      stage(collection, copy._id, copy);
      writes.push(() => base.set(collection, copy));
    },
    remove: async (collection, id) => {
      stage(collection, id, null);
      writes.push(() => remove(collection, id));
    },
    ...(base.patch
      ? {
          patch: async (collection: string, id: string, fields: Record<string, unknown>) => {
            if (monitored.has(collection))
              throw new Error('Catalog recording requires a complete product write');
            writing = true;
            const copy = structuredClone(fields);
            writes.push(async () => {
              await base.patch?.(collection, id, copy);
            });
          },
        }
      : {}),
  };
  const result = await operation(store);
  const changes: CatalogSeoChange[] = [];
  for (const { collection, id } of targets.values())
    changes.push({
      collection,
      before: await load(collection, id),
      after: after.get(key(collection, id)) ?? null,
    });
  for (const change of changes) {
    if (change.collection !== 'productVariants') continue;
    for (const id of [change.before?.productId, change.after?.productId]) {
      if (typeof id === 'string' && id) await load('products', id);
    }
  }
  const requests = catalogSeoRequests(changes, config, settings.now ?? new Date().toISOString(), {
    before: (id) => before.get(key('products', id)) ?? null,
    after: (id) =>
      after.has(key('products', id))
        ? (after.get(key('products', id)) ?? null)
        : (before.get(key('products', id)) ?? null),
  });
  const permit = await planCatalogSeoWrite(
    { get: load, set: base.set.bind(base) },
    config,
    changes,
    requests,
    settings.now ?? new Date().toISOString(),
  );
  const extraWrites = permit ? 1 + permit.pages.length : 0;
  if (reads + writes.length + requests.length + extraWrites > 100)
    throw new Error('Catalog SEO transaction exceeds its operation budget');
  await writeCatalogSeoPermit(base, permit);
  for (const write of writes) await write();
  for (const request of requests) await base.set('catalogSeoRequests', request);
  return result;
}
