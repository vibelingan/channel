import { fetchFully } from '../smoke-http.mjs';
import { assertOrigin, freeze } from './input.mjs';

const routes = Object.freeze({
  'public-api': { method: 'GET', path: '/api/health' },
  admin: { method: 'POST', path: '/api/admin', body: '{"action":"health"}' },
  'alibaba-catalog-sync': { method: 'GET', path: '/api/alibaba-catalog-sync/health' },
});
export function createFunctionHealthProbe({ target, apiOrigin, request = fetchFully }) {
  const fixed = freeze(structuredClone(target));
  assertOrigin(fixed.siteOrigin);
  assertOrigin(apiOrigin);
  return async (name, expectedCodeSha, { signal } = {}) => {
    const route = Object.hasOwn(routes, name) ? routes[name] : null;
    if (!route || !/^[a-f0-9]{40}$/.test(expectedCodeSha))
      throw new Error('Unknown function health target');
    try {
      const result = await request(route.method, apiOrigin + route.path, {
        signal,
        timeoutMs: 15_000,
        maxBytes: 65_536,
        redirect: 'error',
        headers: {
          'cache-control': 'no-cache',
          ...(route.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(route.body ? { body: route.body } : {}),
      });
      signal?.throwIfAborted();
      const body = JSON.parse(result.body.toString('utf8'));
      if (
        result.status !== 200 ||
        body.ok !== true ||
        body.data?.status !== 'ok' ||
        body.data.service !== name ||
        body.data.releaseId !== expectedCodeSha
      )
        throw new Error('Health identity mismatch');
      return freeze({ status: 'healthy', name, codeSha: expectedCodeSha, target: fixed });
    } catch {
      throw new Error('Function health or release identity check failed');
    }
  };
}
