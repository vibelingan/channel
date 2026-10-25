import { defineMiddleware } from 'astro:middleware';
import { releaseInfo } from '@vibelingan-channel/shared/release';
/** Preview service addresses must not be indexed before the reviewed domain cutover. */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Channel-Blog-Version', releaseInfo('blog-pages').releaseId);
  if (process.env.BLOG_PREVIEW_ONLY === '1')
    response.headers.set('X-Robots-Tag', 'noindex,nofollow');
  return response;
});
