/** Admin-requested one-product refresh through the same mirror/draft path as a run. */
import { randomUUID } from 'node:crypto';
import type { AlibabaClient } from '@vibelingan-channel/alibaba-catalog-sync';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  acquireAlibabaSyncLease,
  releaseAlibabaSyncLease,
} from '@vibelingan-channel/db';
import { ingestProductDetail } from './ingest.ts';
import { createDraftForSource } from './linking.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';
import { promoteLinkedProduct } from './promotion.ts';

const DETAIL_METHOD = 'alibaba.icbu.product.get';

export interface SelectedProductSyncDeps {
  client: AlibabaClient;
  getAccessToken: () => Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>;
  now: () => string;
}

export type SelectedProductSyncResult =
  | {
      ok: true;
      sourceProductId: string;
      sourceKey: string;
      productId: string;
      draftCreated: boolean;
      offerCount: number;
    }
  | {
      ok: false;
      reason:
        | 'lease-busy'
        | 'lease-corrupt'
        | 'not-connected'
        | 'provider-unavailable'
        | 'raw-write-failed'
        | 'api-error'
        | 'malformed-response'
        | 'missing-product-id'
        | 'product-id-mismatch'
        | 'invalid-source-observation'
        | 'lease-lost'
        | 'draft-failed'
        | 'promotion-failed';
    };

export async function syncSelectedAlibabaProduct(input: {
  sourceProductId: string;
  deps: SelectedProductSyncDeps;
}): Promise<SelectedProductSyncResult> {
  const holder = `selected-${randomUUID()}`;
  const acquiredAt = input.deps.now();
  const grant = await acquireAlibabaSyncLease(
    PRIMARY_CONNECTION_ID,
    holder,
    acquiredAt,
    ALIBABA_SYNC_LEASE_TTL_MS,
  );
  if (grant.result === 'busy') return { ok: false, reason: 'lease-busy' };
  if (grant.result === 'corrupt') return { ok: false, reason: 'lease-corrupt' };
  const guard = () => ({
    connectionId: PRIMARY_CONNECTION_ID,
    holder,
    fence: grant.fence,
    now: input.deps.now(),
  });

  try {
    const access = await input.deps.getAccessToken();
    if (!access.ok) return { ok: false, reason: 'not-connected' };
    const params = { product_id: input.sourceProductId, language: 'ENGLISH' };
    const response = await input.deps.client.callApi({
      apiPath: DETAIL_METHOD,
      protocol: 'top',
      params,
      accessToken: access.accessToken,
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) return { ok: false, reason: 'provider-unavailable' };

    const runId = `selected-${input.deps.now().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const ingested = await ingestProductDetail({
      bodyText: response.bodyText,
      expectedSourceProductId: input.sourceProductId,
      endpointId: 'product.get',
      requestFingerprint: input.deps.client.fingerprintFor({ apiPath: DETAIL_METHOD, params }),
      connectionId: PRIMARY_CONNECTION_ID,
      runId,
      now: input.deps.now(),
      captureMode: 'selected',
      leaseGuard: guard,
    });
    if (!ingested.ok) return { ok: false, reason: ingested.error };

    const draft = await createDraftForSource(ingested.sourceKey, { now: input.deps.now() });
    if (!draft.ok) return { ok: false, reason: 'draft-failed' };
    const promoted = await promoteLinkedProduct({
      sourceKey: ingested.sourceKey,
      guard: guard(),
      now: input.deps.now(),
    });
    if (!promoted.ok) {
      return {
        ok: false,
        reason: promoted.reason === 'fence-rejected' ? 'lease-lost' : 'promotion-failed',
      };
    }
    return {
      ok: true,
      sourceProductId: input.sourceProductId,
      sourceKey: ingested.sourceKey,
      productId: draft.productId,
      draftCreated: draft.created,
      offerCount: ingested.offerKeys.length,
    };
  } finally {
    await releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, grant.fence, input.deps.now());
  }
}
