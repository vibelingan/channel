import { releaseInfo } from '@vibelingan-channel/shared/release';
import type { APIRoute } from 'astro';
import { blogRequestIndexing } from '../../lib/blog/indexing-policy.ts';
import { blogServerLocation } from '../../lib/blog/page.ts';
export const GET: APIRoute = ({ site, request }) =>
  Response.json(
    {
      ...releaseInfo('blog-pages'),
      siteOrigin: site?.origin,
      previewOnly: process.env.BLOG_PREVIEW_ONLY !== '0',
      indexingPolicyVersion: 1,
      mediaDelivery: blogServerLocation(process.env.BLOG_MEDIA_DELIVERY).mediaDelivery,
      indexing: blogRequestIndexing({
        siteOrigin: site?.origin,
        requestHost: request.headers.get('host'),
        previewFlag: process.env.BLOG_PREVIEW_ONLY,
      }),
    },
    { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
  );
