import {
  type CatalogDetailView,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import { readApiEnvelope } from '../../lib/api-envelope.ts';

import {
  type DetailFailure,
  type DetailPageRead,
  type DetailPageRequest,
  type DetailTransport,
  fetchCatalogDetailResponse,
} from './catalog-detail-request.ts';

export type {
  DetailFailure,
  DetailPageRequest,
  DetailTransport,
} from './catalog-detail-request.ts';

export type DetailPage = CatalogDetailView & { revision: string };
export type DetailPageResult =
  | { status: 'ready'; detail: DetailPage; bytes: number }
  | DetailFailure;
/** Request and decode an approved detail page, including follow-up pages and direct links. */
export async function fetchCatalogDetailPage(
  request: DetailPageRequest,
  transport: DetailTransport = {},
): Promise<DetailPageResult> {
  return decodeCatalogDetailPage(await fetchCatalogDetailResponse(request, transport));
}

export async function decodeCatalogDetailPage(read: DetailPageRead): Promise<DetailPageResult> {
  if (read.status !== 'ready') return read;
  const { productId, revision, page, pageSize, signal } = read;
  if (signal?.aborted) return { status: 'cancelled' };
  // Reuse the existing envelope owner over an already bounded body, not res.json()/a cast.
  const envelope = await readApiEnvelope<unknown>(new Response(read.text));
  if (signal?.aborted) return { status: 'cancelled' };
  if (!envelope) return { status: 'invalid-response' };
  if (!envelope.ok) {
    if (envelope.error.code === 'CONFLICT') return { status: 'refresh-required' };
    if (envelope.error.code === 'NOT_FOUND') return { status: 'not-found' };
    if (envelope.error.code === 'RATE_LIMITED') return { status: 'rate-limited' };
    return { status: 'unavailable' };
  }
  const decoded = decodeCatalogDetailView(envelope.data);
  if (
    !decoded.ok ||
    !decoded.value.revision ||
    decoded.value._id !== productId ||
    decoded.value.variants.page !== page ||
    (decoded.value.variants.pageSize !== pageSize &&
      !(page === 1 && revision === undefined && decoded.value.variants.pageSize < pageSize))
  ) {
    return { status: 'invalid-response' };
  }
  if (revision !== undefined && revision !== decoded.value.revision)
    return { status: 'refresh-required' };
  return {
    status: 'ready',
    detail: { ...decoded.value, revision: decoded.value.revision },
    bytes: read.bytes,
  };
}
