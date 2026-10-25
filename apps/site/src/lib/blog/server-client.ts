import { ArticleListSchema } from '@vibelingan-channel/articles/public-read';
import { parsePublishedArticle } from '@vibelingan-channel/articles/publication';

/** Fixed deployment configuration only; article input cannot choose another host. */
function apiOrigin() {
  const url = new URL(process.env.BLOG_API_ORIGIN ?? '');
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('BLOG_API_ORIGIN must be an HTTPS origin (HTTP loopback is allowed locally)');
  return url.origin;
}
async function read(path: string, maxBytes: number, binary = false) {
  const response = await fetch(`${apiOrigin()}${path}`, {
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: binary ? 'image/png,image/jpeg,image/webp' : 'application/json' },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('Article API is unavailable');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (
    binary
      ? !/^image\/(?:png|jpeg|webp)$/.test(contentType)
      : !/^application\/json(?:;|$)/.test(contentType)
  ) {
    await response.body?.cancel();
    throw Error('Unexpected article content type');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw Error('Article API returned no body');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw Error('Article API body exceeds its limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, contentType };
}
async function json(path: string, maxBytes: number) {
  const response = await read(path, maxBytes);
  if (!response) return null;
  const envelope: unknown = JSON.parse(response.bytes.toString('utf8'));
  if (!envelope || typeof envelope !== 'object' || Reflect.get(envelope, 'ok') !== true)
    throw Error('Article API did not return success');
  return Reflect.get(envelope, 'data');
}
export async function publicArticle(slug: string) {
  const data = await json(`/api/articles/slug/${encodeURIComponent(slug)}`, 512 * 1024);
  if (data === null) return null;
  const article = parsePublishedArticle(data);
  if (article.content.slug !== slug) throw Error('Article API returned a different URL');
  return article;
}
export async function publicArticleList(after?: string) {
  const data = await json(
    `/api/articles${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    64 * 1024,
  );
  return ArticleListSchema.parse(data);
}
export async function publicArticleImage(id: string, file: string) {
  return read(
    `/api/articles/media/${encodeURIComponent(id)}/${encodeURIComponent(file)}`,
    3 * 1024 * 1024,
    true,
  );
}
