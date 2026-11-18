import type { CatalogImagePresentation } from '@vibelingan-channel/shared/catalog-image-presentation';
import { apiMediaUrl } from '../../lib/api-url.ts';

/** Presentation never changes the logical photo identity used by galleries/inquiries. */
export function responsiveImageAttributes(
  source: string | undefined,
  presentation: CatalogImagePresentation | undefined,
  sizes: string,
) {
  if (!source || !presentation) return {};
  const entry = Object.entries(presentation).find(([original]) => apiMediaUrl(original) === source);
  if (!entry) return {};
  return {
    srcSet: entry[1]
      .map((candidate) => `${apiMediaUrl(candidate.url)} ${candidate.width}w`)
      .join(', '),
    sizes,
  };
}
