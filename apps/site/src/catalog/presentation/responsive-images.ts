import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import { apiMediaUrl } from '../../lib/api-url.ts';

export const catalogGalleryImageSizes =
  '(min-width: 1280px) 520px, (min-width: 1024px) calc(50vw - 88px), (min-width: 640px) 520px, calc(100vw - 72px)';

/** Presentation never changes the logical photo identity used by galleries/inquiries. */
export function responsiveImageCandidates(
  source: string | undefined,
  presentation: CatalogImagePresentation | undefined,
) {
  if (!source || !presentation) return undefined;
  return Object.entries(presentation).find(([original]) => apiMediaUrl(original) === source)?.[1];
}

export function imageCandidateAttributes(
  candidates: CatalogImagePresentation[string] | undefined,
  sizes: string,
  mapMediaUrl: (url: string) => string = (url) => url,
) {
  if (!candidates) return {};
  return {
    srcSet: candidates
      .map((candidate) => `${mapMediaUrl(apiMediaUrl(candidate.url))} ${candidate.width}w`)
      .join(', '),
    sizes,
  };
}

export function responsiveImageAttributes(
  source: string | undefined,
  presentation: CatalogImagePresentation | undefined,
  sizes: string,
) {
  return imageCandidateAttributes(responsiveImageCandidates(source, presentation), sizes);
}
