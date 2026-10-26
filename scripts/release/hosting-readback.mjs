import { assertErrorDocument, assertMutableCachePolicy } from '../hosting-contract.mjs';
import { readHttpWithRetry } from '../read-http-retry.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { assertHostingPath, assertOrigin, isHash, limits, sha256 } from './input.mjs';

/** Verify normal URLs first. A cache-busted response cannot substitute for what visitors receive. */
export async function verifyHostingObject({
  target,
  entry,
  path = entry.path,
  expectedStatus = 200,
  request = fetchFully,
  signal,
  timeoutMs = 15_000,
}) {
  assertOrigin(target.site);
  assertHostingPath(path);
  if (
    ![200, 404].includes(expectedStatus) ||
    !isHash(entry.sha256) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    entry.bytes > limits.fileBytes
  )
    throw new Error('Invalid hosting expectation');
  const publicPath = path === 'index.html' ? '/' : `/${path.replace(/\/index\.html$/, '/')}`;
  const url = new URL(publicPath, target.site).href;
  const mutable = expectedStatus === 404 || /\.(html|xml|json|txt)$/.test(path);
  const mime =
    expectedStatus === 404 || path.endsWith('.html')
      ? ['text/html']
      : path.endsWith('.xml')
        ? ['application/xml', 'text/xml']
        : path.endsWith('.json')
          ? ['application/json']
          : path.endsWith('.js')
            ? ['application/javascript', 'text/javascript']
            : path.endsWith('.css')
              ? ['text/css']
              : null;
  const checks = [];
  let etag;
  for (const mode of ['ordinary', 'revalidate', 'conditional']) {
    signal?.throwIfAborted();
    const response = await readHttpWithRetry(
      'GET',
      url,
      {
        timeoutMs,
        maxBytes: Math.max(1, entry.bytes + 1),
        signal,
        redirect: 'error',
        headers: {
          'accept-encoding': 'identity',
          ...(mode === 'ordinary' ? {} : { 'cache-control': 'no-cache' }),
          ...(mode === 'conditional' ? { 'if-none-match': etag } : {}),
        },
      },
      request,
    );
    const observedEtag = response.headers.get('etag');
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (mutable) assertMutableCachePolicy(cacheControl);
    if (!observedEtag || (etag && observedEtag !== etag))
      throw new Error('Missing or changed hosting ETag');
    if (mode === 'conditional' && response.status === 304) {
      if (response.body.length) throw new Error('Unexpected conditional response body');
    } else {
      if (
        response.status !== expectedStatus ||
        response.body.length !== entry.bytes ||
        sha256(response.body) !== entry.sha256
      )
        throw new Error('Hosting status or content mismatch');
      if (
        mime &&
        !mime.includes(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase())
      )
        throw new Error('Hosting MIME mismatch');
      if (expectedStatus === 404 || entry.path === '404.html' || entry.path.endsWith('/404.html'))
        assertErrorDocument(response.body);
    }
    etag = observedEtag;
    checks.push({ mode, status: response.status, etag, cacheControl });
  }
  return { url, status: expectedStatus, sha256: entry.sha256, bytes: entry.bytes, etag, checks };
}
