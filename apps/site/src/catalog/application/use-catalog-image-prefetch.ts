import { useEffect } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';
import { createImagePrefetchQueue } from './catalog-image-prefetch.ts';

/** Wait for the visible hero, then idle-prefetch a bounded set of SKU photos. */
export function useCatalogImagePrefetch(sources: readonly string[], ready: boolean) {
  const key = JSON.stringify([...new Set(sources)].slice(0, 9));
  useEffect(() => {
    if (!ready) return;
    const connection: unknown = Reflect.get(navigator, 'connection');
    if (
      connection &&
      typeof connection === 'object' &&
      (Reflect.get(connection, 'saveData') === true ||
        ['slow-2g', '2g'].includes(String(Reflect.get(connection, 'effectiveType'))))
    )
      return;
    const queue = createImagePrefetchQueue(
      (source) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.fetchPriority = 'low';
          image.referrerPolicy = 'no-referrer';
          image.onload = image.onerror = () => resolve();
          // Same URL, credentials and referrer policy as ProductMedia: the browser
          // can coalesce an in-flight fetch if the buyer selects this image early.
          image.src = apiMediaUrl(source);
        }),
    );
    const start = () => queue.enqueue(JSON.parse(key));
    const idle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(start, { timeout: 1500 })
        : undefined;
    const timer = idle === undefined ? window.setTimeout(start, 500) : undefined;
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) window.clearTimeout(timer);
      queue.stop();
    };
  }, [key, ready]);
}
