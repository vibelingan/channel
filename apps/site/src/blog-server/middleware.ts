import { defineMiddleware } from 'astro:middleware';
/** Preview service addresses must not be indexed before the reviewed domain cutover. */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  response.headers.set('Cache-Control', 'no-store');
  if (process.env.BLOG_PREVIEW_ONLY === '1')
    response.headers.set('X-Robots-Tag', 'noindex,nofollow');
  return response;
});
