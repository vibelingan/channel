import type { APIRoute } from 'astro';
import { publicArticleImage } from '../../../../../lib/blog/server-client.ts';
export const GET: APIRoute = async ({ params }) => {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const id = params.id ?? '';
  const file = params.file ?? '';
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ||
    !/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(file)
  )
    return new Response('Not found', { status: 404, headers });
  try {
    const result = await publicArticleImage(id, file);
    if (!result) return new Response('Not found', { status: 404, headers });
    return new Response(new Uint8Array(result.bytes), {
      headers: { ...headers, 'Content-Type': result.contentType },
    });
  } catch {
    return new Response('Image temporarily unavailable', {
      status: 503,
      headers: { ...headers, 'Retry-After': '30' },
    });
  }
};
