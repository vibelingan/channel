/** Indexing is opt-in for the canonical HTTP host. This never grants content access. */
export function blogRequestIndexing(input: {
  siteOrigin: string | undefined;
  requestHost: string | null;
  previewFlag: string | undefined;
}) {
  const enabled = input.previewFlag === '0';
  let canonicalHost = false;
  try {
    const site = new URL(input.siteOrigin ?? '');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
    canonicalHost =
      site.origin === input.siteOrigin &&
      (site.protocol === 'https:' || (site.protocol === 'http:' && loopback)) &&
      input.requestHost?.toLowerCase() === site.host;
  } catch {
    // Missing or malformed configuration keeps every request out of the index.
  }
  return { enabled, canonicalHost, allowed: enabled && canonicalHost };
}
