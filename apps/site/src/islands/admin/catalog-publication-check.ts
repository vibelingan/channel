import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { CATALOG_DETAIL_PAGE_MAX_BYTES } from '@vibelingan-channel/shared/catalog-detail-pagination';
import type { CatalogIssue } from '@vibelingan-channel/shared/catalog-issues';
import type { CatalogProductOperationStatus } from '@vibelingan-channel/shared/catalog-product-operation';
import { readApiEnvelope } from '../../lib/api-envelope.ts';
import { apiUrl } from '../../lib/api-url.ts';
import { AdminApiError } from './api.ts';
import {
  type PublicationOptions,
  type PublicationScope,
  PublicationScopeSchema,
  managePublication,
} from './catalog-product-operation-api.ts';

type CheckReason = 'not-complete' | 'historical' | 'unknown' | 'paused';
type UnconfirmedPublication = {
  reason: CheckReason;
  scope: PublicationScope;
  status?: CatalogProductOperationStatus;
  revision?: never;
  name?: never;
  error?: { code: string; message: string; issues: readonly CatalogIssue[] };
};
export type PublicationCheckResult =
  | UnconfirmedPublication
  | {
      reason: 'confirmed';
      scope: PublicationScope;
      status: Extract<CatalogProductOperationStatus, { state: 'complete' }>;
      revision: string;
      name: string;
      error?: never;
    };
export type PublicationCheckOptions = {
  signal?: AbortSignal;
  request?: PublicationOptions['request'];
  fetch?: typeof globalThis.fetch;
};
const unreadable = () =>
  new AdminApiError(
    'INVALID_RESPONSE',
    'The website could not confirm this publication. Check the same task again.',
  );
async function boundedText(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw unreadable();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CATALOG_DETAIL_PAGE_MAX_BYTES) {
        await reader.cancel();
        throw unreadable();
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Confirm this immutable publication using reads only; a failed check never republishes it. */
export async function checkPublication(
  input: unknown,
  options: PublicationCheckOptions = {},
): Promise<PublicationCheckResult> {
  if (!fitsJsonBudget(input, 4096, 12))
    throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication scope.');
  const parsed = PublicationScopeSchema.safeParse(input);
  if (!parsed.success) throw new AdminApiError('VALIDATION_ERROR', 'Invalid publication scope.');
  let binding: PublicationScope = Object.freeze(parsed.data);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000);
  const fetch = options.fetch ?? globalThis.fetch;
  let current: CatalogProductOperationStatus | undefined;
  const result = (reason: CheckReason, error?: unknown): UnconfirmedPublication => ({
    reason,
    scope: binding,
    ...(current ? { status: current } : {}),
    ...(error !== undefined
      ? {
          error:
            error instanceof AdminApiError
              ? { code: error.code, message: error.message, issues: error.issues }
              : {
                  code: 'UNAVAILABLE',
                  message: 'Publication could not be checked. Check its original task again.',
                  issues: [],
                },
        }
      : {}),
  });
  const query = async () => {
    signal.throwIfAborted();
    const answer = await managePublication(
      {
        action: 'product-operation-get',
        productId: binding.productId,
        operationId: binding.operationId,
      },
      {
        signal,
        ...(options.request ? { request: options.request } : {}),
        ...(binding.inputDigest ? { expectedInputDigest: binding.inputDigest } : {}),
      },
    );
    current = answer.status;
    binding = Object.freeze({
      productId: current.productId,
      operationId: current.operationId,
      inputDigest: current.inputDigest,
    });
    return current;
  };
  try {
    const initial = await query();
    if (initial.state !== 'complete') return result('not-complete');
    if (!initial.current) return result('historical');
    const revision = initial.completion.revision;
    let name: string | undefined;
    let publicFailure: { error: unknown } | undefined;
    try {
      const path = `/api/products/${encodeURIComponent(binding.productId)}/detail?page=1&pageSize=1&revision=${encodeURIComponent(revision)}&pagination=byte-budget-v1`;
      signal.throwIfAborted();
      const response = await fetch(apiUrl(path), {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
      const envelope = await readApiEnvelope<unknown>(
        new Response(await boundedText(response, signal), { status: response.status }),
      );
      if (!envelope) throw unreadable();
      if (!envelope.ok)
        throw new AdminApiError(envelope.error.code, envelope.error.message, envelope.error.issues);
      if (!response.ok) throw unreadable();
      if (!fitsJsonBudget(envelope.data, CATALOG_DETAIL_PAGE_MAX_BYTES, 32)) throw unreadable();
      const detail = decodeCatalogDetailView(envelope.data);
      if (
        !detail.ok ||
        detail.value._id !== binding.productId ||
        detail.value.revision !== revision ||
        detail.value.variants.page !== 1
      )
        throw unreadable();
      name = detail.value.name;
    } catch (error) {
      publicFailure = { error };
    }
    const latest = await query();
    if (latest.state !== 'complete') throw unreadable();
    if (!latest.current) return result('historical');
    if (latest.completion.revision !== revision) throw unreadable();
    if (publicFailure) return result('unknown', publicFailure.error);
    if (name === undefined) throw unreadable();
    return { reason: 'confirmed', scope: binding, status: latest, revision, name };
  } catch (error) {
    return result(signal.aborted ? 'paused' : 'unknown', error);
  }
}
