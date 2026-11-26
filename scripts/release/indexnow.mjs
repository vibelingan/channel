import {
  assertIndexingResponse,
  projectRobotsAllows,
} from '../../apps/site/src/lib/seo/index-readiness.ts';
import { inspectSitemap } from '../../apps/site/src/lib/seo/output-gate.ts';
import { fetchFully } from '../smoke-http.mjs';
import { productPath } from './input.mjs';

export const siteOrigin = 'https://supplychainsai.com';
const blogMapPath = '/blog/sitemap.xml';
const articlePath = /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const stabilizationMs = 30 * 60_000;
const maxBatch = 20;
const postUrl = 'https://api.indexnow.org/indexnow';

function sitePath(url) {
  const parsed = new URL(url);
  if (parsed.origin !== siteOrigin || url !== siteOrigin + parsed.pathname)
    throw Error('IndexNow URL must be on the canonical HTTPS host');
  return parsed.pathname;
}

const allowedPath = (path) => productPath.test(path) || articlePath.test(path);
const read = (method, url, options) =>
  fetchFully(method, url, {
    redirect: 'error',
    timeoutMs: 12_000,
    maxBytes: 2 * 1024 * 1024,
    ...options,
  });
const publicHeaders = { 'cache-control': 'no-cache', 'accept-encoding': 'identity' };
const bodyText = (result) => new TextDecoder('utf-8', { fatal: true }).decode(result.body);

export async function readIndexNowSitemaps(request = read) {
  async function readMap(url, kind) {
    const response = await request('GET', url, { headers: publicHeaders });
    if (
      response.status !== 200 ||
      !/^(?:application|text)\/xml(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    )
      throw Error(`IndexNow could not read sitemap: ${url}`);
    const map = await inspectSitemap(bodyText(response), siteOrigin);
    if (map.kind !== kind) throw Error('Unexpected sitemap type');
    return map;
  }

  const index = await readMap(`${siteOrigin}/sitemap-index.xml`, 'index');
  const paths = index.urls.map(sitePath);
  if (
    paths.length < 2 ||
    paths.length > 12 ||
    !paths.includes(blogMapPath) ||
    paths.some((path) => path !== blogMapPath && !/^\/sitemap-\d+\.xml$/.test(path))
  )
    throw Error('IndexNow needs the complete product and Blog sitemap set');
  const snapshot = {};
  const maps = await Promise.all(
    index.urls.map(async (url) => ({ path: sitePath(url), map: await readMap(url, 'urls') })),
  );
  for (const { path: mapPath, map } of maps) {
    const blogMap = mapPath === blogMapPath;
    for (const page of map.urls) {
      const path = sitePath(page);
      if (!allowedPath(path)) continue;
      if (blogMap !== articlePath.test(path) || Object.hasOwn(snapshot, page))
        throw Error('IndexNow sitemap contains a misplaced or duplicate content URL');
      const date = map.lastModified.get(page);
      if (
        (blogMap || date !== undefined) &&
        (!date || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(date) || !Number.isFinite(Date.parse(date)))
      )
        throw Error(`Missing or invalid public change date: ${path}`);
      snapshot[page] = date ?? '';
    }
  }
  return snapshot;
}

export function planIndexNow(snapshot, previous, now = Date.now()) {
  if (!previous) return { baseline: snapshot, pending: {}, retryAt: 0, initialized: true };
  const { baseline, retryAt } = previous;
  const pending = {};
  const urls = new Set([...Object.keys(snapshot), ...Object.keys(baseline)]);
  for (const url of urls) {
    if (!allowedPath(sitePath(url))) throw Error('Unexpected URL in IndexNow state');
    const current = snapshot[url] ?? null;
    if (current === (baseline[url] ?? null)) continue;
    const existing = previous.pending[url];
    pending[url] = existing?.date === current ? existing : { date: current, since: now };
  }
  return { baseline, pending, retryAt, initialized: false };
}

export async function runIndexNow({
  state,
  save,
  key,
  request = read,
  now = Date.now(),
  submit = false,
  saveObservations = submit,
}) {
  if (submit && !/^[a-zA-Z0-9-]{8,128}$/.test(key ?? ''))
    throw Error('Set a valid INDEXNOW_KEY before enabling submission');
  const snapshot = await readIndexNowSitemaps(request);
  const plan = planIndexNow(snapshot, state, now);
  const ready = Object.entries(plan.pending)
    .filter(([, entry]) => now - entry.since >= stabilizationMs)
    .sort(([, a], [, b]) => a.since - b.since || Number(a.date !== null) - Number(b.date !== null))
    .slice(0, maxBatch);
  if (saveObservations) await save(plan);
  const result = {
    initialized: plan.initialized,
    observed: Object.keys(snapshot).length,
    pending: Object.keys(plan.pending).length,
    ready: ready.map(([url]) => url),
    submitted: [],
    deferred: [],
    indexNowStatus: null,
  };
  if (!submit || !ready.length || now < plan.retryAt) return result;

  const keyLocation = `${siteOrigin}/${key}.txt`;
  const keyResponse = await request('GET', keyLocation, {
    headers: publicHeaders,
    maxBytes: 512,
  }).catch(() => {
    throw Error('IndexNow ownership file could not be read');
  });
  if (keyResponse.status !== 200 || bodyText(keyResponse).trim() !== key)
    throw Error('IndexNow ownership file must return the configured key on the canonical host');
  const robotsResponse = await request('GET', `${siteOrigin}/robots.txt`, {
    headers: publicHeaders,
  });
  if (robotsResponse.status !== 200) throw Error('IndexNow could not read public robots.txt');
  const robots = bodyText(robotsResponse);
  const verified = [];
  for (const [url, entry] of ready) {
    try {
      const path = sitePath(url);
      if (!projectRobotsAllows(robots, path)) throw Error('robots.txt blocks this URL');
      const response = await request('GET', url, { headers: publicHeaders });
      if (entry.date === null) {
        if (![404, 410].includes(response.status)) throw Error('Withdrawal is not live');
      } else {
        const page = await assertIndexingResponse({
          path,
          origin: siteOrigin,
          status: response.status,
          headers: response.headers,
          html: bodyText(response),
          robots,
        });
        const expectedKind = productPath.test(path) ? 'product' : 'article';
        if (page.kind !== expectedKind || (page.content.updatedAt ?? '') !== entry.date)
          throw Error('Live HTML and sitemap change dates differ');
      }
      verified.push(url);
    } catch (error) {
      result.deferred.push({ url, reason: error.message });
      plan.pending[url] = { ...entry, since: now };
    }
  }
  if (!verified.length) {
    await save(plan);
    return result;
  }

  // A failed or ambiguous request leaves the observations intact and slows the next attempt.
  plan.retryAt = now + 15 * 60_000;
  await save(plan);
  const response = await request('POST', postUrl, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(siteOrigin).hostname,
      key,
      keyLocation,
      urlList: verified,
    }),
    maxBytes: 16 * 1024,
  });
  result.indexNowStatus = response.status;
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const deadline = /^\d+$/.test(retryAfter)
        ? now + Number(retryAfter) * 1000
        : Date.parse(retryAfter);
      if (Number.isFinite(deadline)) plan.retryAt = Math.max(plan.retryAt, deadline);
    }
    await save(plan);
    return result;
  }
  if (response.status !== 200 && response.status !== 202) return result;
  const baseline = { ...plan.baseline };
  const pending = { ...plan.pending };
  for (const url of verified) {
    if (pending[url].date === null) delete baseline[url];
    else baseline[url] = pending[url].date;
    delete pending[url];
  }
  await save({ ...plan, baseline, pending, retryAt: 0 });
  return { ...result, submitted: verified, pending: Object.keys(pending).length };
}
