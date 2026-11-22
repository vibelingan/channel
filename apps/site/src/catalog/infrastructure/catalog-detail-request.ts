import { apiUrl } from '../../lib/api-url.ts';
import { DETAIL_PAGE_BYTE_LIMIT } from '../detail-limits.ts';

export type DetailFailure = {
  status:
    | 'invalid-request'
    | 'invalid-response'
    | 'refresh-required'
    | 'not-found'
    | 'forbidden'
    | 'rate-limited'
    | 'unavailable'
    | 'network-error'
    | 'cancelled'
    | 'limit-exceeded';
};

export interface DetailPageRequest {
  productId: string;
  page?: number;
  pageSize?: number;
  revision?: string;
}
export interface DetailTransport {
  /** Saved snapshots keep the strict detail DTO accepted by earlier renderers. */
  includeImagePresentation?: boolean;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export type DetailPageRead =
  | DetailFailure
  | {
      status: 'ready';
      productId: string;
      revision: string | undefined;
      page: number;
      pageSize: number;
      signal: AbortSignal | undefined;
      text: string;
      bytes: number;
    };

function validIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function httpFailure(status: number): DetailFailure {
  if (status === 404) return { status: 'not-found' };
  if (status === 409) return { status: 'refresh-required' };
  if (status === 401 || status === 403) return { status: 'forbidden' };
  if (status === 429) return { status: 'rate-limited' };
  if (status === 400) return { status: 'invalid-request' };
  return { status: 'unavailable' };
}

/** Read decompressed bytes with a hard cap, including chunked responses. */
async function boundedBody(
  response: Response,
  signal?: AbortSignal,
): Promise<{ status: 'ready'; text: string; bytes: number } | DetailFailure> {
  if (!response.body) return { status: 'invalid-response' };
  const reader = response.body.getReader();
  // Cancellation cleanup is best effort; its rejection must not replace the read outcome.
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  // A byte cap alone would still permit millions of tiny retained chunk objects.
  const body = new Uint8Array(DETAIL_PAGE_BYTE_LIMIT);
  let bytes = 0;
  try {
    if (signal?.aborted) {
      cancel();
      return { status: 'cancelled' };
    }
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) return { status: 'cancelled' };
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > DETAIL_PAGE_BYTE_LIMIT) {
        cancel();
        return { status: 'limit-exceeded' };
      }
      body.set(chunk.value, bytes - chunk.value.byteLength);
    }
  } catch {
    return { status: signal?.aborted ? 'cancelled' : 'network-error' };
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  try {
    return {
      status: 'ready',
      text: new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes)),
      bytes,
    };
  } catch {
    return { status: 'invalid-response' };
  }
}

/** Anonymous approved-detail route only; never reads browser JWT or raw provider data. */
export async function fetchCatalogDetailResponse(
  request: DetailPageRequest,
  transport: DetailTransport = {},
): Promise<DetailPageRead> {
  const { productId, revision } = request;
  const page = request.page ?? 1;
  const pageSize = request.pageSize ?? 50;
  if (
    !validIdentity(productId) ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50 ||
    !Number.isSafeInteger((page - 1) * pageSize) ||
    (revision !== undefined && !validIdentity(revision)) ||
    (page > 1 && revision === undefined)
  ) {
    return { status: 'invalid-request' };
  }
  let encodedId: string;
  try {
    encodedId = encodeURIComponent(productId);
  } catch {
    return { status: 'invalid-request' };
  }
  if (transport.signal?.aborted) return { status: 'cancelled' };
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    view: 'sections-media',
    pagination: 'byte-budget-v1',
  });
  if (transport.includeImagePresentation !== false) query.set('media', 'responsive-v1');
  if (revision !== undefined) query.set('revision', revision);
  let response: Response;
  try {
    response = await (transport.fetch ?? globalThis.fetch)(
      apiUrl(`/api/products/${encodedId}/detail?${query}`),
      {
        method: 'GET',
        signal: transport.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      },
    );
  } catch {
    return { status: transport.signal?.aborted ? 'cancelled' : 'network-error' };
  }
  if (transport.signal?.aborted || response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    return transport.signal?.aborted
      ? { status: 'cancelled' }
      : response.ok
        ? { status: 'invalid-response' }
        : httpFailure(response.status);
  }
  const body = await boundedBody(response, transport.signal);
  if (body.status !== 'ready') return body;
  return { ...body, productId, revision, page, pageSize, signal: transport.signal };
}
