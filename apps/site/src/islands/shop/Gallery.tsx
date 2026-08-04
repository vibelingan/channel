import { CATALOG_IMAGE_MAX_COUNT } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';
import { ProductMedia, productMediaKey } from './ProductMedia.tsx';

interface Props {
  images: string[];
  alt: string;
  productId?: string;
  viewAllLabel?: string;
  showLessLabel?: string;
  unavailableLabel?: string;
}

interface GalleryThumbnailListProps {
  images: readonly string[];
  activeIndex: number;
  expanded: boolean;
  viewAllLabel: string;
  showLessLabel: string;
  unavailableLabel?: string;
  onSelect: (index: number) => void;
  onToggle: () => void;
}

const INITIAL_PREVIEW_COUNT = 4;

export interface VisibleGalleryThumbnail {
  image: string;
  index: number;
  key: string;
}

function galleryThumbnailIdentities(images: readonly string[]): VisibleGalleryThumbnail[] {
  const occurrences = new Map<string, number>();
  return images.map((image, index) => {
    const occurrence = (occurrences.get(image) ?? 0) + 1;
    occurrences.set(image, occurrence);
    return { image, index, key: `${image}:${occurrence}` };
  });
}

export function visibleGalleryThumbnails(
  images: readonly string[],
  activeIndex: number,
  expanded: boolean,
): VisibleGalleryThumbnail[] {
  const identities = galleryThumbnailIdentities(images);
  if (expanded || images.length <= INITIAL_PREVIEW_COUNT) {
    return identities;
  }
  const indices = activeIndex < INITIAL_PREVIEW_COUNT ? [0, 1, 2, 3] : [0, 1, 2, activeIndex];
  return indices.flatMap((index) => identities[index] ?? []);
}

export function boundedGalleryImages(images: readonly string[]): string[] {
  return images
    .map((image) => image.trim())
    .filter(Boolean)
    .map(apiMediaUrl)
    .slice(0, CATALOG_IMAGE_MAX_COUNT);
}

export function gallerySessionKey(
  productId: string | undefined,
  images: readonly string[],
): string {
  return `${productId ?? ''}:${productMediaKey(images)}`;
}

export function GalleryThumbnailList({
  images,
  activeIndex,
  expanded,
  viewAllLabel,
  showLessLabel,
  unavailableLabel,
  onSelect,
  onToggle,
}: GalleryThumbnailListProps) {
  const visibleThumbnails = visibleGalleryThumbnails(images, activeIndex, expanded);

  if (images.length <= 1) return null;

  return (
    <div className="mt-4 min-w-0">
      <div id="gallery-thumbnails" className="flex min-w-0 flex-wrap justify-center gap-3">
        {visibleThumbnails.map(({ image, index, key }) => (
          <button
            key={key}
            type="button"
            data-gallery-thumbnail={index}
            onClick={() => onSelect(index)}
            className={`h-20 w-20 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 bg-surface-alt transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${
              index === activeIndex ? 'border-brand-600' : 'border-slate-200 hover:border-slate-400'
            }`}
            aria-label={`View image ${index + 1}`}
            aria-pressed={index === activeIndex}
          >
            <ProductMedia
              sources={[image]}
              alt=""
              unavailableLabel={unavailableLabel}
              width={80}
              height={80}
              fetchPriority="low"
              imageClassName="h-full w-full object-contain"
            />
          </button>
        ))}
      </div>

      {images.length > INITIAL_PREVIEW_COUNT ? (
        <div className="mt-4 text-center">
          <button
            type="button"
            data-gallery-view-all
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls="gallery-thumbnails"
            className="min-h-11 cursor-pointer rounded-md px-4 text-sm font-semibold text-brand-700 underline decoration-brand-300 underline-offset-4 transition-colors motion-reduce:transition-none hover:text-brand-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            {expanded ? showLessLabel : viewAllLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GallerySession({
  images,
  alt,
  productId: _productId,
  viewAllLabel = 'View All',
  showLessLabel = 'Show Less',
  unavailableLabel = 'Product image unavailable',
}: Props) {
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const activeSource = images[active];

  return (
    <div className="min-w-0" data-gallery>
      <div
        data-gallery-frame
        className="mx-auto aspect-square w-full max-w-[520px] overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-surface-alt"
      >
        <ProductMedia
          sources={activeSource ? [activeSource] : []}
          alt={alt}
          unavailableLabel={unavailableLabel}
          loading="eager"
          imageClassName="h-full w-full object-contain"
        />
      </div>

      <GalleryThumbnailList
        images={images}
        activeIndex={active}
        expanded={expanded}
        viewAllLabel={viewAllLabel}
        showLessLabel={showLessLabel}
        unavailableLabel={unavailableLabel}
        onSelect={setActive}
        onToggle={() => setExpanded((current) => !current)}
      />
    </div>
  );
}

export function Gallery({
  images,
  alt,
  productId,
  viewAllLabel,
  showLessLabel,
  unavailableLabel,
}: Props) {
  const list = boundedGalleryImages(images);
  return (
    <GallerySession
      key={gallerySessionKey(productId, list)}
      images={list}
      alt={alt}
      productId={productId}
      viewAllLabel={viewAllLabel}
      showLessLabel={showLessLabel}
      unavailableLabel={unavailableLabel}
    />
  );
}
