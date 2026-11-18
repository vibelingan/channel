import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import { useEffect } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';
import {
  catalogGalleryImageSizes,
  responsiveImageAttributes,
} from '../presentation/responsive-images.ts';
import { createImagePrefetchQueue } from './catalog-image-prefetch.ts';

/** Wait for the visible hero, then idle-prefetch a bounded set of SKU photos. */
export function useCatalogImagePrefetch(
  sources: readonly string[],
  ready: boolean,
  presentation?: CatalogImagePresentation,
) {
  const key = JSON.stringify(
    [...new Set(sources)].slice(0, 9).map((source) => {
      const src = apiMediaUrl(source);
      return { src, ...responsiveImageAttributes(src, presentation, catalogGalleryImageSizes) };
    }),
  );
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
    // Decode only this hook's own stable key, never an external response.
    const images: { src: string; srcSet?: string; sizes?: string }[] = JSON.parse(key);
    const descriptors = new Map(images.map((image) => [image.src, image]));
    const queue = createImagePrefetchQueue(
      (source) =>
        new Promise<void>((resolve) => {
          const image = new Image();
          image.fetchPriority = 'low';
          image.referrerPolicy = 'no-referrer';
          image.onload = image.onerror = () => resolve();
          const descriptor = descriptors.get(source);
          if (descriptor?.srcSet) {
            image.sizes = descriptor.sizes ?? catalogGalleryImageSizes;
            image.srcset = descriptor.srcSet;
          }
          // Match the displayed image so a click can reuse the ongoing download.
          image.src = source;
        }),
    );
    const start = () => queue.enqueue(images.map((image) => image.src));
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
