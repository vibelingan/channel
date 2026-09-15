import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared';
import { apiMediaUrl } from '../../lib/api-url.ts';

/** Shared layout; callers authorize URLs before supplying them (public IDs or admin blobs). */
export function CatalogDescriptionImages({ images }: { images: readonly string[] }) {
  if (!images.length) return null;
  return (
    <details data-description-images className="border-b border-slate-200 py-6">
      <summary className="cursor-pointer font-display text-xl font-semibold text-ink">
        Product description images ({images.length})
      </summary>
      <div className="mx-auto mt-5 max-w-3xl space-y-4">
        {images.slice(0, PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT).map((src, index) => (
          <img
            key={`${index}:${src}`}
            src={apiMediaUrl(src)}
            alt={`Product description ${index + 1}`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-auto w-full rounded-lg border border-slate-100 object-contain"
          />
        ))}
      </div>
    </details>
  );
}
