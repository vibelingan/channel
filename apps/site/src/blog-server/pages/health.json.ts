import { releaseInfo } from '@vibelingan-channel/shared/release';
import type { APIRoute } from 'astro';
import { blogRequestIndexing } from '../../lib/blog/indexing-policy.ts';
export const GET: APIRoute = ({ site, request }) =>
  Response.json(
    {
      ...releaseInfo('blog-pages'),
      siteOrigin: site?.origin,
      previewOnly: process.env.BLOG_PREVIEW_ONLY !== '0',
      indexingPolicyVersion: 1,
      indexing: blogRequestIndexing({
        siteOrigin: site?.origin,
        requestHost: request.headers.get('host'),
        previewFlag: process.env.BLOG_PREVIEW_ONLY,
      }),
    },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );
