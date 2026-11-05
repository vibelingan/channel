import { defineMiddleware } from 'astro:middleware';
import { releaseInfo } from '@vibelingan-channel/shared/release';
import { blogRequestIndexing } from '../lib/blog/indexing-policy.ts';
/** Preview service addresses must not be indexed before the reviewed domain cutover. */
export const onRequest = defineMiddleware(async (context, next) => {
  // File endpoints keep their ordinary URLs; HTML pages use one canonical slash form.
  const path = context.url.pathname;
  let response: Response;
  if (!path.endsWith('/') && !path.split('/').at(-1)?.includes('.')) {
    const canonical = new URL(context.url);
    canonical.pathname += '/';
    // A relative target preserves HTTPS when the gateway talks plain HTTP to Node.
    response = context.redirect(`${canonical.pathname}${canonical.search}`, 308);
  } else response = await next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Channel-Blog-Version', releaseInfo('blog-pages').releaseId);
  const indexing = blogRequestIndexing({
    siteOrigin: context.site?.origin,
    requestHost: context.request.headers.get('host'),
    previewFlag: process.env.BLOG_PREVIEW_ONLY,
  });
  if (!indexing.allowed || response.status !== 200)
    response.headers.set('X-Robots-Tag', 'noindex,nofollow');
  return response;
});
