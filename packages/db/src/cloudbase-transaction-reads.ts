import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';

/** One queue per native transaction; independent transactions keep their concurrency. */
export function serializeCloudBaseTransactionReads<T>(
  read: (collection: string, id: string) => Promise<T>,
): (collection: string, id: string) => Promise<T> {
  let previous: Promise<void> = Promise.resolve();
  return (collection, id) => {
    const result = previous.then(() => read(collection, id));
    previous = result.then(() => undefined);
    // Keep the rejected chain so queued reads cannot run in an aborted transaction.
    // The caller still receives the original rejection through result.
    void previous.catch(() => undefined);
    return result;
  };
}

/** Reuse only pre-write catalog reads in this one native transaction snapshot. */
export function createCatalogTransactionReads<T>(
  read: (collection: string, id: string) => Promise<T>,
): {
  get: (collection: string, id: string) => Promise<T>;
  beforeWrite: () => void;
} {
  const cache = new Map<string, { value: T }>();
  const maxDocumentBytes = 512 * 1024;
  const maxTotalBytes = 4 * 1024 * 1024;
  let usedBytes = 0;
  let enabled = true;
  const get = serializeCloudBaseTransactionReads(async (collection, id) => {
    const key = JSON.stringify([collection, id]);
    // This lookup stays inside the serial queue: a native failure poisons hits too.
    const cached = enabled ? cache.get(key) : undefined;
    if (cached) return structuredClone(cached.value);
    const value = await read(collection, id);
    if (
      enabled &&
      cache.size < 98 &&
      fitsJsonBudget(value, Math.min(maxDocumentBytes, maxTotalBytes - usedBytes))
    ) {
      try {
        // Capture before returning the first result so caller mutation cannot alias it.
        const captured = structuredClone(value);
        const bytes = Buffer.byteLength(JSON.stringify(captured));
        cache.set(key, { value: captured });
        usedBytes += bytes;
      } catch {
        // Unusual SDK values keep their original direct-read behavior.
      }
    }
    return value;
  });
  return {
    get,
    beforeWrite: () => {
      enabled = false;
      cache.clear();
      usedBytes = 0;
    },
  };
}
