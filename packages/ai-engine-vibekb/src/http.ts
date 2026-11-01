import { EngineError } from '@vibelingan-channel/ai-engine/errors';

export function endpoint(value: string, allowLocal: boolean): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        allowLocal &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      ))
  )
    throw new Error('Invalid fixed provider endpoint');
  return url;
}

/** The SDK may make several requests; each must remain at this fixed endpoint. */
export function boundedFetch(target: URL, api: typeof fetch, limit = 262144): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.href !== target.href)
      throw new EngineError('invalid_request', { safeDetail: 'provider_destination_changed' });
    const response = await api(input, { ...init, redirect: 'error', credentials: 'omit' });
    if (response.status === 405 && init?.method === 'GET') return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EngineError(
        response.status === 429
          ? 'quota'
          : [401, 403].includes(response.status)
            ? 'invalid_request'
            : 'unavailable',
        { safeDetail: 'provider_request_rejected' },
      );
    }
    if (!response.body) return response;
    let bytes = 0;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > limit) {
            await reader.cancel();
            controller.error(
              new EngineError('invalid_request', { safeDetail: 'provider_body_too_large' }),
            );
          } else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
