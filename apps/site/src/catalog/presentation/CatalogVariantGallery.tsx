import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';
import { useState } from 'react';
import { Gallery, boundedGalleryImages } from '../../islands/shop/Gallery.tsx';
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
  const selected = selection.status === 'selected' ? selection.variant : undefined;
  const specific = selected
    ? selected.images.length
      ? variantMediaSources(images, selection)
      : (sourceImages ?? [])
    : [];
  const assigned = new Map<string, string | undefined>();
  const assignedUrls = new Set<string>();
  for (const source of specific) {
    const normalized = boundedGalleryImages([source])[0];
    if (!normalized || assigned.has(normalized)) continue;
    const resolved = selected?.images.length ? resolveImage(source.trim()) : source;
    const url = resolved ? boundedGalleryImages([resolved])[0] : undefined;
    if (url && assignedUrls.has(url)) continue;
    assigned.set(normalized, url);
    if (url) assignedUrls.add(url);
  }
  const general = images
    .flatMap((source) => boundedGalleryImages([source]))
    .filter((source) => !assigned.has(source) && !assignedUrls.has(source));
  const photos = [...new Set([...assigned.keys(), ...general])];
  const label = selected
    ? (catalogVariantLabels(variants, (index) => `Configuration ${index + 1}`)[
        variants.findIndex((v) => v.id === selected.id)
      ] ?? 'Selected configuration')
    : '';
  return (
    <section data-variant-gallery>
      <p className="mb-3 text-sm font-semibold text-ink" aria-live="polite">
        Product photos
      </p>
      <Gallery
        images={photos}
        imageLabels={photos.map((source) =>
          assigned.has(source)
            ? `${name} - ${label} (selected configuration)`
            : `${name} - General product photo`,
        )}
        resolveImage={(source) => (assigned.has(source) ? assigned.get(source) : source)}
        alt={name}
        productId={productId}
        layout="detail"
        mainImagePriority="high"
        onMainImageLoad={onMainImageLoad}
        unavailableLabel={
          loadingImages
            ? 'Loading images…'
            : selected && photos.length === 0
              ? 'No photo is assigned to this configuration.'
              : unavailableLabel
        }
      />
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
