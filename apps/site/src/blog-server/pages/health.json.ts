import { releaseInfo } from '@vibelingan-channel/shared/release';
import type { APIRoute } from 'astro';
export const GET: APIRoute = ({ site }) =>
  Response.json(
    {
      ...releaseInfo('blog-pages'),
      siteOrigin: site?.origin,
      previewOnly: process.env.BLOG_PREVIEW_ONLY === '1',
    },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );
