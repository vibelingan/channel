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

/** Use the first public gallery photo at a ready size suitable for link previews. */
export function productPreviewImage(entry: ProductSnapshotEntry, apiOrigin: string | undefined) {
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

  const sitePath = (url: string) =>
    siteCatalogImagePath(url.startsWith('/') ? apiOrigin + url : url, apiOrigin);
  const original = source && sitePath(source);
  if (!original || original.includes('?')) return undefined;

  for (const requested of [1280, 640]) {
    const candidate = candidates?.find(
      ({ url, width, height }) =>
        sitePath(url) === `${original}?w=${requested}` &&
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
