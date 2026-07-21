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
  } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a positive safe integer, got ${timeoutMs}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`maxBytes must be a positive safe integer, got ${maxBytes}`);
  }

  const controller = new AbortController();
  const timeoutError = new Error(`${method} ${url} timed out after ${timeoutMs}ms`);
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let byteLength = 0;

    // Drain every body before returning. Leaving a static-hosting image body
    // unread can retain the Undici socket and keep an otherwise-passed CI step alive.
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          byteLength += value.byteLength;
          if (byteLength > maxBytes) {
            const sizeError = new Error(
              `${method} ${url} exceeded ${maxBytes}-byte response limit`,
            );
            controller.abort(sizeError);
            await reader.cancel(sizeError).catch(() => {});
            throw sizeError;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.concat(chunks, byteLength),
    };
  } catch (error) {
    if (controller.signal.reason === timeoutError) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
