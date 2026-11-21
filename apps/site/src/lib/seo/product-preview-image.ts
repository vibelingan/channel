import { startDetailPages } from '../../catalog/application/catalog-detail-pages.ts';
import { createCatalogMediaState } from '../../catalog/application/catalog-media.ts';
import { variantMediaSources } from '../../catalog/application/catalog-variant-media.ts';
import { resolveVariantSelection } from '../../catalog/application/catalog-variant-state.ts';
import {
  responsiveImageCandidates,
  siteCatalogImagePath,
} from '../../catalog/presentation/responsive-images.ts';
import { apiMediaUrl } from '../api-url.ts';
import type { ProductSnapshotEntry } from './product-snapshot.ts';

function catalogPhotoPath(url: string, apiOrigin: string) {
  return siteCatalogImagePath(url.startsWith('/') ? apiOrigin + url : url, apiOrigin);
}

/** Some supplier listings reuse the same photo for unrelated products. */
export function conflictingProductPhotoPaths(
  entries: readonly ProductSnapshotEntry[],
  apiOrigin: string | undefined,
) {
  const conflicting = new Set<string>();
  if (!apiOrigin) return conflicting;
  const ownerNames = new Map<string, string>();
  for (const { product, detail } of entries) {
    if (product.published === false) continue;
    const name = (detail?.name ?? product.name).trim().toLowerCase().replace(/\s+/g, ' ');
    const images = [
      ...(product.images ?? []),
      ...(detail?.images ?? []),
      ...(detail?.variants.items.flatMap((variant) => variant.images) ?? []),
    ];
    for (const image of images) {
      const path = catalogPhotoPath(image, apiOrigin);
      if (!path || conflicting.has(path)) continue;
      const owner = ownerNames.get(path);
      if (owner === undefined) ownerNames.set(path, name);
      else if (owner !== name) conflicting.add(path);
    }
  }
  return conflicting;
}

/** Use the first public gallery photo at a ready size suitable for link previews. */
export function productPreviewImage(
  entry: ProductSnapshotEntry,
  apiOrigin: string | undefined,
  conflicting?: ReadonlySet<string>,
) {
  const { product, detail } = entry;
  if (
    !apiOrigin ||
    !detail ||
    product.published === false ||
    detail._id !== product._id ||
    detail.revision !== entry.revision
  )
    return undefined;

  const initial = startDetailPages(detail, new TextEncoder().encode(JSON.stringify(detail)).length);
  if (initial.status !== 'ready') return undefined;
  const [source] = createCatalogMediaState(
    [
      ...variantMediaSources(detail.images, resolveVariantSelection(initial.value)),
      ...detail.images,
    ],
    apiMediaUrl,
  ).sources;
  const candidates =
    responsiveImageCandidates(source, detail.imagePresentation) ??
    responsiveImageCandidates(source, product.imagePresentation);

  const original = source && catalogPhotoPath(source, apiOrigin);
  if (!original || original.includes('?') || conflicting?.has(original)) return undefined;

  for (const requested of [1280, 640]) {
    const candidate = candidates?.find(
      ({ url, width, height }) =>
        catalogPhotoPath(url, apiOrigin) === `${original}?w=${requested}` &&
        width >= 640 &&
        height >= 320 &&
        width <= 3 * height &&
        height <= 3 * width,
    );
    if (candidate)
      return {
        path: `${original}?w=${requested}`,
        alt: detail.name,
        width: candidate.width,
        height: candidate.height,
        mimeType: 'image/webp' as const,
      };
  }
}
