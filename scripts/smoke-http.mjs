import { TextDecoder } from 'node:util';

export const DEFAULT_SMOKE_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_SMOKE_HTTP_MAX_BYTES = 5 * 1024 * 1024;

export function decodeUtf8(body) {
  return new TextDecoder().decode(body);
}

export async function fetchFully(method, url, options = {}) {
  const {
    body,
    headers,
    maxBytes = DEFAULT_SMOKE_HTTP_MAX_BYTES,
    timeoutMs = DEFAULT_SMOKE_HTTP_TIMEOUT_MS,
    signal,
    redirect = 'follow',
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a positive safe integer, got ${timeoutMs}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`maxBytes must be a positive safe integer, got ${maxBytes}`);
  }

  signal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutError = new Error(`${method} ${url} timed out after ${timeoutMs}ms`);
  let reader;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason) => {
    controller.abort(reason);
    reader?.cancel(controller.signal.reason).catch(() => {});
    rejectAbort(controller.signal.reason);
  };
  const onExternalAbort = () => abort(signal.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => abort(timeoutError), timeoutMs);

  const read = async () => {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect,
    });
    if (controller.signal.aborted) response.body?.cancel(controller.signal.reason).catch(() => {});
    controller.signal.throwIfAborted();
    reader = response.body?.getReader();
    const chunks = [];
    let byteLength = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          byteLength += value.byteLength;
          if (byteLength > maxBytes) {
            const sizeError = new Error(
              `${method} ${url} exceeded ${maxBytes}-byte response limit`,
            );
            abort(sizeError);
            throw sizeError;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    controller.signal.throwIfAborted();
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.concat(chunks, byteLength),
    };
  };
  try {
    // The deadline covers headers and every body chunk even if transport abort is ignored.
    return await Promise.race([read(), aborted]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
