import type { APIRoute } from 'astro';
import { publicArticleList } from '../../lib/blog/server-client.ts';
const entities: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => entities[c] ?? c);
export const GET: APIRoute = async ({ site, url }) => {
  const headers = { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' };
  try {
    const entries: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 84; page++) {
      const list = await publicArticleList(after);
      for (const a of list.articles)
        entries.push(
          `<url><loc>${xml(new URL(`/blog/${a.content.slug}/`, site ?? url.origin).href)}</loc><lastmod>${a.modifiedAt}</lastmod></url>`,
        );
      if (entries.length > 1000) throw Error('Article sitemap limit exceeded');
      if (!list.next)
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.length ? `<url><loc>${xml(new URL('/blog/', site ?? url.origin).href)}</loc></url>` : ''}${entries.join('')}</urlset>`,
          { headers },
        );
      if (list.next <= (after ?? '')) throw Error('Article pagination did not advance');
      after = list.next;
    }
    throw Error('Article sitemap scan limit exceeded');
  } catch {
    return new Response('Article sitemap temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
    });
  }
};
