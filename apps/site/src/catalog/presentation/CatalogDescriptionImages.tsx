import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared/media';
import { useEffect, useRef, useState } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';
import { responsiveImageAttributes } from './responsive-images.ts';

const descriptionImageSizes = '(min-width: 832px) 768px, calc(100vw - 32px)';

function DescriptionImage({
  source,
  alt,
  imagePresentation,
}: {
  source: string;
  alt: string;
  imagePresentation: CatalogImagePresentation | undefined;
}) {
  const src = apiMediaUrl(source);
  const [useDefault, setUseDefault] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const responsive = responsiveImageAttributes(src, imagePresentation, descriptionImageSizes);
  // Hints are decoded against the exact list of public description URLs.
  const largest = imagePresentation?.[source]?.reduce((best, candidate) =>
    candidate.width > best.width ? candidate : best,
  );
  const useSizes = Boolean(responsive.srcSet && !useDefault);
  useEffect(() => {
    const image = ref.current;
    if (useSizes && image?.complete && image.naturalWidth === 0) setUseDefault(true);
  }, [useSizes]);
  return (
    <img
      ref={ref}
      src={src}
      {...(useSizes ? responsive : {})}
      width={largest?.width}
      height={largest?.height}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="h-auto w-full rounded-lg border border-slate-100 object-contain"
      onError={useSizes ? () => setUseDefault(true) : undefined}
    />
  );
}

/** Shared layout; callers authorize URLs before supplying them (public IDs or admin blobs). */
export function CatalogDescriptionImages({
  images,
  productName,
  imagePresentation,
}: {
  images: readonly string[];
  productName?: string;
  imagePresentation?: CatalogImagePresentation | undefined;
}) {
  if (!images.length) return null;
  return (
    <section data-description-images className="border-b border-slate-200 py-6">
      <h2 className="font-display text-xl font-semibold text-ink">
        Product description images ({images.length})
      </h2>
      <div className="mx-auto mt-5 max-w-3xl space-y-4">
        {images.slice(0, PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT).map((src, index) => (
          <DescriptionImage
            key={`${index}:${src}`}
            source={src}
            imagePresentation={imagePresentation}
            alt={
              productName
                ? `${productName} — description image ${index + 1}`
                : `Product description ${index + 1}`
            }
          />
        ))}
      </div>
    </section>
  );
}
