import type { CollectionDoc } from '@vibelingan-channel/shared';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { getImagePreview } from './api.ts';

/**
 * Where the admin list's thumbnail comes from. The public image address
 * (`/api/images/:id`) serves only photos of published products, so an
 * unpublished product's own photo is shown from the Alibaba photo it was
 * copied from (the same picture, no request to our API) or, when that is not
 * known, through the signed-in admin preview.
 */
export type ThumbnailSource =
  | { kind: 'public'; imageId: string }
  /** `imageId`: our copy, shown if Alibaba no longer serves the original. */
  | { kind: 'alibaba'; url: string; imageId?: string }
  | { kind: 'admin'; imageId: string }
  | null;

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

/** The Alibaba photo the gallery's first photo was copied from, while the sync owns the gallery. */
function copiedFrom(doc: CollectionDoc, ids: readonly string[]): string | undefined {
  const auto = doc.alibabaAutoPhotos;
  const gallery = auto && typeof auto === 'object' ? Reflect.get(auto, 'gallery') : undefined;
  if (!gallery || typeof gallery !== 'object') return undefined;
  const sources = strings(Reflect.get(gallery, 'sources'));
  const filled = strings(Reflect.get(gallery, 'imageIds'));
  if (!sources || !filled || filled.length !== ids.length) return undefined;
  if (!filled.every((id, index) => id === ids[index])) return undefined;
  // Copied in source order, skipping photos that were not copied.
  const skipped = new Set([
    ...(strings(Reflect.get(gallery, 'unusable')) ?? []),
    ...(strings(Reflect.get(gallery, 'missing')) ?? []),
  ]);
  const source = sources.find((url) => !skipped.has(url));
  return source ? alibabaSourcePreviewUrls([source], 1)[0] : undefined;
}

export function productThumbnailSource(doc: CollectionDoc): ThumbnailSource {
  const ids = strings(doc.imageIds) ?? [];
  const first = ids[0];
  if (first) {
    if (doc.published === true) return { kind: 'public', imageId: first };
    const url = copiedFrom(doc, ids);
    return url ? { kind: 'alibaba', url, imageId: first } : { kind: 'admin', imageId: first };
  }
  const url = alibabaSourcePreviewUrls(doc.alibabaSourceImageUrls, 1)[0];
  return url ? { kind: 'alibaba', url } : null;
}

/** Admin preview of one image as a `data:` URL (cached in `getImagePreview`). */
export function adminThumbnail(imageId: string): Promise<string> {
  return getImagePreview(imageId);
}
