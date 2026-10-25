import { releaseInfo } from '@vibelingan-channel/shared/release';
import type { APIRoute } from 'astro';
export const GET: APIRoute = () =>
  Response.json(releaseInfo('blog-pages'), {
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
