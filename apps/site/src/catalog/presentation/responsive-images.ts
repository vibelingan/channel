import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import { apiMediaUrl } from '../../lib/api-url.ts';
import { createCatalogMediaState } from '../application/catalog-media.ts';

export const catalogCardImageSizes =
  '(min-width: 1280px) 280px, (min-width: 1024px) calc(25vw - 52px), (min-width: 640px) calc(50vw - 56px), calc(100vw - 80px)';

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

export function siteCatalogImagePath(url: string, apiOrigin: string): string | undefined {
  if (!url.startsWith(`${apiOrigin}/api/images/`)) return undefined;
  const path = url.slice(apiOrigin.length);
  return /^\/api\/images\/[A-Za-z0-9_-]+(?:\?w=(?:160|640|1280))?$/.test(path) ? path : undefined;
}

/** Only preload a responsive photo already served through a public catalog route. */
export function catalogCardImagePreload(
  sources: readonly string[],
  presentation: CatalogImagePresentation | undefined,
  apiOrigin: string | undefined,
) {
  if (!apiOrigin) return undefined;
  const [source] = createCatalogMediaState(sources, apiMediaUrl).sources;
  if (!source || !siteCatalogImagePath(source, apiOrigin)) return undefined;
  const candidates = responsiveImageCandidates(source, presentation);
  if (!candidates?.length) return undefined;
  return imageCandidateAttributes(
    candidates,
    catalogCardImageSizes,
    (url) => siteCatalogImagePath(url, apiOrigin) ?? url,
  );
}
