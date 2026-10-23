import { identity, sha256 } from '../release/input.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
export async function readBlogSiteBaseline(request = fetchFully) {
  const entries = [];
  for (const path of ['/', '/headphones/', '/sitemap-index.xml', '/sitemap-0.xml']) {
    const response = await request('GET', policy.siteOrigin + path, {
      timeoutMs: 15000,
      maxBytes: 4 * 1024 * 1024,
      redirect: 'error',
      headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache' },
    });
    if (response.status !== 200)
      throw Object.assign(new Error('Existing website is not healthy'), {
        code: 'STOP_EXTERNAL_CHANGE',
      });
    entries.push({ path, sha256: sha256(response.body), bytes: response.body.length });
  }
  return entries;
}
export async function checkBlogSiteBaseline(expected, request = fetchFully) {
  if (identity(await readBlogSiteBaseline(request)) !== identity(expected))
    throw Object.assign(
      new Error('Existing website changed during the isolated test; stop all further writes'),
      { code: 'STOP_EXTERNAL_CHANGE' },
    );
}
