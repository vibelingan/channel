import { PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT, PRODUCT_IMAGE_MAX_COUNT } from './media.ts';

const ALLOWED_SOURCE_HOST_SUFFIXES = ['alicdn.com', 'alibaba.com'];

/**
 * Supplier photo addresses we may copy or preview: HTTPS on Alibaba's hosts,
 * de-duplicated, in Alibaba's order, at most `limit` (never more than the
 * description limit). Old HTTP addresses on the same CDN are upgraded.
 */
export function alibabaPhotoSources(value: unknown, limit = PRODUCT_IMAGE_MAX_COUNT): string[] {
  return alibabaPhotoSourcesInfo(value, limit).urls;
}

/** The bounded sources plus how many valid distinct sources there are in all. */
export function alibabaPhotoSourcesInfo(
  value: unknown,
  limit = PRODUCT_IMAGE_MAX_COUNT,
): { urls: string[]; total: number } {
  if (!Number.isFinite(limit)) return { urls: [], total: 0 };
  const targetLimit = Math.min(PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT, Math.max(0, Math.trunc(limit)));
  const all = allAlibabaPhotoSources(value);
  return { urls: targetLimit === 0 ? [] : all.slice(0, targetLimit), total: all.length };
}

/** Every valid distinct source, in Alibaba's order (at most 200), for choosing beyond the limit. */
export function allAlibabaPhotoSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (out.length >= 200) break;
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2_048)
      continue;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      // Historical Alibaba description images use HTTP on the same public CDN.
      // Upgrade only after the host allowlist below; never permit HTTP fetching.
      if (url.protocol === 'http:' && url.port === '') url.protocol = 'https:';
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        (url.port !== '' && url.port !== '443') ||
        !ALLOWED_SOURCE_HOST_SUFFIXES.some(
          (suffix) => host === suffix || host.endsWith(`.${suffix}`),
        )
      ) {
        continue;
      }
      const safeUrl = url.toString();
      if (seen.has(safeUrl)) continue;
      seen.add(safeUrl);
      out.push(safeUrl);
    } catch {
      // Invalid provider strings are ignored; they never become DOM URLs.
    }
  }
  return out;
}
