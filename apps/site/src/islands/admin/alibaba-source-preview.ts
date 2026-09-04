const ALLOWED_SOURCE_HOST_SUFFIXES = ['alicdn.com', 'alibaba.com'];

/** Safe HTTPS supplier-image candidates for authenticated admin preview only. */
export function alibabaSourcePreviewUrls(value: unknown, limit = 5): string[] {
  if (!Array.isArray(value)) return [];
  const targetLimit = Math.min(9, Math.max(0, Math.trunc(limit)));
  if (targetLimit === 0) return [];
  const out: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2_048)
      continue;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
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
      out.push(url.toString());
      if (out.length >= targetLimit) break;
    } catch {
      // Invalid provider strings are ignored; they never become DOM URLs.
    }
  }
  return out;
}
