import { fetchFully } from '../smoke-http.mjs';
/** Prove the actual index and sitemap use Node, rather than trusting a health-only route. */
export async function assertServerBlogReady(siteOrigin, request = fetchFully) {
  const origin = new URL(siteOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== siteOrigin ||
    origin.username ||
    origin.password
  )
    throw Error('Exact HTTPS Blog origin required');
  const options = { timeoutMs: 30000, maxBytes: 2 * 1024 * 1024, redirect: 'error' };
  const response = await request('GET', `${siteOrigin}/blog/health.json`, options);
  const health = JSON.parse(response.body.toString());
  if (
    response.status !== 200 ||
    health.service !== 'blog-pages' ||
    health.status !== 'ok' ||
    health.siteOrigin !== siteOrigin ||
    !/^[a-f0-9]{40}$/.test(health.releaseId) ||
    typeof health.previewOnly !== 'boolean'
  )
    throw Error('The actual Blog route must be served independently before server-mode delivery');
  for (const [path, type] of [
    ['/blog/', 'text/html'],
    ['/blog/sitemap.xml', 'application/xml'],
  ]) {
    const actual = await request('GET', `${siteOrigin}${path}`, options);
    if (
      actual.status !== 200 ||
      actual.headers.get('x-channel-blog-version') !== health.releaseId ||
      !(actual.headers.get('content-type') ?? '').startsWith(type)
    )
      throw Error('The actual Blog index and sitemap must use the verified page service');
  }
  return { releaseId: health.releaseId, previewOnly: health.previewOnly };
}

/** The current backend owns the delivery mode; an old build flag must not restore static article copies. */
export function assertBlogDeliveryOwnership(serverEnabled, actualMode) {
  if (serverEnabled ? actualMode !== 'server' : ![undefined, 'static'].includes(actualMode))
    throw Error('The static build and actual article delivery mode differ');
}
