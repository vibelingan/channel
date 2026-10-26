import { setTimeout as pause } from 'node:timers/promises';
import { fetchFully } from './smoke-http.mjs';
const codes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
export function transientHttpRead(error) {
  return (
    codes.has(error?.code) ||
    codes.has(error?.cause?.code) ||
    ['AbortError', 'TimeoutError'].includes(error?.name) ||
    / timed out after [0-9]+ms$/.test(error?.message ?? '')
  );
}
/** Repeat only a GET/HEAD, including its complete body. Content validation remains the caller's check. */
export async function readHttpWithRetry(method, url, options = {}, request = fetchFully) {
  if (!['GET', 'HEAD'].includes(method))
    throw Error('Only read-only HTTP operations may be retried');
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const response = await request(method, url, options);
      if (![502, 503, 504].includes(response.status) || attempt === 2) return response;
    } catch (error) {
      if (options.signal?.aborted || !transientHttpRead(error) || attempt === 2) throw error;
    }
    await pause(250 * (attempt + 1), undefined, { signal: options.signal });
  }
  throw Error('HTTP read did not complete');
}
