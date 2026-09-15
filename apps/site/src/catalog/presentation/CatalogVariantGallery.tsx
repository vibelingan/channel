import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';
import { useState } from 'react';
import { Gallery } from '../../islands/shop/Gallery.tsx';
import { catalogVariantLabels } from '../application/catalog-variant-labels.ts';
import { variantMediaSources } from '../application/catalog-variant-media.ts';
import type { VariantSelection } from '../application/catalog-variant-state.ts';
import { useCatalogImagePrefetch } from '../application/use-catalog-image-prefetch.ts';

export interface CatalogVariantGalleryProps {
  productId: string;
  revision?: string;
  name: string;
  images: readonly string[];
  selection: VariantSelection;
  variants: readonly CatalogDetailVariant[];
  /** Admin-only transport adapter. Public views use the validated DTO directly. */
  resolveImage?: (source: string) => string | undefined;
  sourceImages?: readonly string[];
  loadingImages?: boolean;
  unavailableLabel: string;
  onMainImageLoad?: () => void;
}
const identity = (source: string) => source;

function Session({
  productId,
  name,
  images,
  selection,
  variants,
  resolveImage = identity,
  sourceImages,
  loadingImages,
  unavailableLabel,
  onMainImageLoad,
}: CatalogVariantGalleryProps) {
  const [general, setGeneral] = useState(false);
  const selected = selection.status === 'selected' ? selection.variant : undefined;
  const specific = selected
    ? variantMediaSources(images, selection).flatMap((src) => {
        const resolved = resolveImage(src);
        return resolved ? [resolved] : [];
      })
    : [];
  // Source previews have an explicit provider URL contract. Do not fall back
  // from a failed owned image to a different source or to the product gallery.
  const photos =
    general || !selected ? images : selected.images.length ? specific : (sourceImages ?? []);
  const label = selected
    ? (catalogVariantLabels(variants, (index) => `Configuration ${index + 1}`)[
        variants.findIndex((v) => v.id === selected.id)
      ] ?? 'Selected configuration')
    : '';
  return (
    <section
      data-variant-gallery
      data-gallery-mode={general || !selected ? 'product' : 'configuration'}
    >
      <p className="mb-3 text-sm font-semibold text-ink" aria-live="polite">
        {general || !selected ? 'Product photos' : `Configuration photos — ${label}`}
      </p>
      <Gallery
        key={general ? 'product' : 'configuration'}
        images={photos}
        alt={general || !selected ? name : `${name} — ${label}`}
        productId={productId}
        layout="detail"
        mainImagePriority="high"
        onMainImageLoad={onMainImageLoad}
        unavailableLabel={
          loadingImages
            ? 'Loading images…'
            : selected && !general && !selected.images.length && !sourceImages?.length
              ? 'No photo is assigned to this configuration.'
              : unavailableLabel
        }
      />
      {selected && images.length > 0 && (
        <button
          type="button"
          onClick={() => setGeneral((v) => !v)}
          className="mt-3 min-h-11 rounded-md px-2 text-sm font-semibold text-brand-700 underline focus-visible:outline-brand-700"
        >
          {general ? 'Back to configuration photos' : `View product gallery (${images.length})`}
        </button>
      )}
      {general && (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          General product photos may include other colors and accessories. Your selected
          configuration has not changed.
        </p>
      )}
    </section>
  );
}

/** One selection/gallery state owner shared by buyer routes and authenticated preview. */
export function CatalogVariantGallery(props: CatalogVariantGalleryProps) {
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const productIdentity = JSON.stringify([props.productId, props.revision]);
  useCatalogImagePrefetch(
    props.resolveImage ? [] : props.variants.flatMap((v) => v.images),
    loadedIdentity === productIdentity,
  );
  const key = JSON.stringify([
    props.productId,
    props.revision,
    props.selection.status === 'selected' ? props.selection.variant.id : props.selection.status,
  ]);
  return (
    <Session key={key} {...props} onMainImageLoad={() => setLoadedIdentity(productIdentity)} />
  );
}
