/**
 * Page-bounded, lease-owned replay of current raw product.get evidence.
 *
 * Dry-run and apply execute the identical preflight. Apply additionally
 * requires the SHA-256 returned by dry-run, so a changed payload/offer set
 * cannot be written under an earlier approval. A page is fully preflighted
 * before its first write; interrupted writes are safe to repeat because every
 * target id is deterministic and the replay never touches canonical products.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  alibabaObservationAdapter,
  extractProductDetail,
  normalizeProductDetail,
  parseAlibabaApiResponse,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import {
  ALIBABA_SYNC_LEASE_TTL_MS,
  type AlibabaLeaseGuard,
  acquireAlibabaSyncLease,
  get,
  list,
  releaseAlibabaSyncLease,
  renewAlibabaSyncLease,
  updateDocWithAlibabaLease,
  upsertDocWithAlibabaLease,
} from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc, FilterModel } from '@vibelingan-channel/shared';
import { listAllDocs } from './list-all.ts';
import { PRIMARY_CONNECTION_ID } from './oauth.ts';

const MAX_RAW_BYTES = 8 * 1024 * 1024;

type LeaseGrant = { result: 'granted'; fence: number } | { result: 'busy' } | { result: 'corrupt' };

export interface AlibabaRawReplayPort {
  now(): string;
  acquireLease(holder: string): Promise<LeaseGrant>;
  renewLease(holder: string, fence: number): Promise<boolean>;
  releaseLease(holder: string, fence: number): Promise<boolean>;
  listSourceProducts(
    afterSourceKey: string,
    limit: number,
  ): Promise<{ items: CollectionDoc[]; total: number }>;
  getDocument(collection: string, id: string): Promise<CollectionDoc | null>;
  listActiveOffers(sourceKey: string): Promise<CollectionDoc[]>;
  readObjectAsBase64(fileId: string): Promise<{ body: string; byteSize?: number }>;
  updateOffer(
    id: string,
    patch: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean>;
  upsertObservation(
    id: string,
    value: Record<string, unknown>,
    createOnly: Record<string, unknown>,
    guard: AlibabaLeaseGuard,
  ): Promise<boolean>;
}

const defaultPort: AlibabaRawReplayPort = {
  now: () => new Date().toISOString(),
  acquireLease: (holder) =>
    acquireAlibabaSyncLease(
      PRIMARY_CONNECTION_ID,
      holder,
      new Date().toISOString(),
      ALIBABA_SYNC_LEASE_TTL_MS,
    ),
  renewLease: (holder, fence) =>
    renewAlibabaSyncLease(
      PRIMARY_CONNECTION_ID,
      holder,
      fence,
      new Date().toISOString(),
      ALIBABA_SYNC_LEASE_TTL_MS,
    ),
  releaseLease: (holder, fence) =>
    releaseAlibabaSyncLease(PRIMARY_CONNECTION_ID, holder, fence, new Date().toISOString()),
  async listSourceProducts(afterSourceKey, limit) {
    const baseClauses: FilterModel['clauses'] = [
      { field: 'connectionId', op: 'eq', value: PRIMARY_CONNECTION_ID },
      { field: 'active', op: 'eq', value: true },
    ];
    const count = await list({
      collection: 'alibabaSourceProducts',
      page: 1,
      pageSize: 1,
      search: '',
      filter: { combinator: 'and', clauses: baseClauses },
    });
    const page = await list({
      collection: 'alibabaSourceProducts',
      page: 1,
      pageSize: limit,
      search: '',
      sort: [{ field: '_id', dir: 'asc' }],
      filter: {
        combinator: 'and',
        clauses: [
          ...baseClauses,
          ...(afterSourceKey ? [{ field: '_id', op: 'gt' as const, value: afterSourceKey }] : []),
        ],
      },
    });
    return { items: page.items, total: count.total };
  },
  getDocument: get,
  async listActiveOffers(sourceKey) {
    return listAllDocs('alibabaSupplierOffers', [
      { field: 'sourceKey', op: 'eq', value: sourceKey },
      { field: 'active', op: 'eq', value: true },
    ]);
  },
  readObjectAsBase64: (fileId) => mediaStorage().getObjectAsBase64(fileId),
  updateOffer: (id, patch, guard) =>
    updateDocWithAlibabaLease('alibabaSupplierOffers', id, patch, guard),
  upsertObservation: (id, value, createOnly, guard) =>
    upsertDocWithAlibabaLease('catalogSourceObservations', id, value, createOnly, guard),
};

export interface AlibabaRawReplayInput {
  mode: 'dry-run' | 'apply';
  afterSourceKey?: string;
  limit?: number;
  expectedPageHash?: string;
  expectedTotalSourceProducts?: number;
}

export interface AlibabaRawReplayFailure {
  sourceKey: string;
  reason:
    | 'invalid-source-row'
    | 'payload-missing'
    | 'invalid-payload-metadata'
    | 'raw-read-failed'
    | 'raw-too-large'
    | 'raw-size-mismatch'
    | 'raw-hash-mismatch'
    | 'malformed-response'
    | 'provider-api-error'
    | 'missing-product-id'
    | 'product-id-mismatch'
    | 'source-key-mismatch'
    | 'offer-set-mismatch'
    | 'invalid-source-observation';
}

export interface AlibabaRawReplayCounts {
  sourceProducts: number;
  observations: number;
  variants: number;
  offers: number;
  attributedVariants: number;
  attributePairs: number;
  warnings: number;
}

export type AlibabaRawReplayResult =
  | {
      ok: false;
      reason: 'invalid-input' | 'lease-busy' | 'lease-corrupt' | 'lease-lost' | 'page-changed';
    }
  | {
      ok: true;
      mode: 'dry-run' | 'apply';
      ready: boolean;
      pageHash: string;
      totalSourceProducts: number;
      afterSourceKey: string;
      nextSourceKey: string;
      done: boolean;
      counts: AlibabaRawReplayCounts;
      priceModes: Record<string, number>;
      failures: AlibabaRawReplayFailure[];
      applied: number;
    };

interface ReplayPlan {
  source: CollectionDoc;
  payloadId: string;
  firstSeenOperationId: string;
  lastSeenOperationId: string;
  normalized: Extract<ReturnType<typeof normalizeProductDetail>, { ok: true }>;
  observation: NonNullable<
    ReturnType<typeof alibabaObservationAdapter.toObservations>['observations'][number]
  >;
}

function textField(doc: CollectionDoc, field: string): string | null {
  const value = doc[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function pageFingerprint(
  plans: readonly ReplayPlan[],
  afterSourceKey: string,
  totalSourceProducts: number,
): string {
  const material = plans.map((plan) => ({
    sourceKey: plan.source._id,
    payloadId: plan.payloadId,
    firstSeenOperationId: plan.firstSeenOperationId,
    lastSeenOperationId: plan.lastSeenOperationId,
    offers: plan.normalized.offers.map((offer) => ({
      offerKey: offer.offerKey,
      sourceAttributes: offer.sourceAttributes,
      pricing: offer.pricing,
    })),
    observation: plan.observation,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ afterSourceKey, totalSourceProducts, material }))
    .digest('hex');
}

export async function replayAlibabaRawPage(
  input: AlibabaRawReplayInput,
  port: AlibabaRawReplayPort = defaultPort,
): Promise<AlibabaRawReplayResult> {
  const limit = input.limit ?? 10;
  const afterSourceKey = input.afterSourceKey ?? '';
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (input.mode === 'apply' &&
      (!/^[0-9a-f]{64}$/.test(input.expectedPageHash ?? '') ||
        !Number.isSafeInteger(input.expectedTotalSourceProducts) ||
        Number(input.expectedTotalSourceProducts) < 0))
  ) {
    return { ok: false, reason: 'invalid-input' };
  }

  const holder = `raw-replay-${randomUUID()}`;
  const grant = await port.acquireLease(holder);
  if (grant.result === 'busy') return { ok: false, reason: 'lease-busy' };
  if (grant.result === 'corrupt') return { ok: false, reason: 'lease-corrupt' };

  try {
    const sourcePage = await port.listSourceProducts(afterSourceKey, limit);
    const rows = sourcePage.items;
    const totalSourceProducts = sourcePage.total;
    if (
      !Number.isSafeInteger(totalSourceProducts) ||
      totalSourceProducts < rows.length ||
      (input.mode === 'apply' && input.expectedTotalSourceProducts !== totalSourceProducts)
    ) {
      return { ok: false, reason: 'page-changed' };
    }
    const plans: ReplayPlan[] = [];
    const failures: AlibabaRawReplayFailure[] = [];

    for (const source of rows) {
      const sourceKey = source._id;
      const connectionId = textField(source, 'connectionId');
      const sourceProductId = textField(source, 'sourceProductId');
      const payloadId = textField(source, 'payloadId');
      const observedAt = textField(source, 'fetchedAt');
      const firstSeenRunId = textField(source, 'firstSeenRunId');
      const lastSeenRunId = textField(source, 'lastSeenRunId');
      if (
        !connectionId ||
        !sourceProductId ||
        !payloadId ||
        !observedAt ||
        !firstSeenRunId ||
        !lastSeenRunId
      ) {
        failures.push({ sourceKey, reason: 'invalid-source-row' });
        continue;
      }
      const payload = await port.getDocument('alibabaSourcePayloads', payloadId);
      if (!payload) {
        failures.push({ sourceKey, reason: 'payload-missing' });
        continue;
      }
      const storageFileId = textField(payload, 'storageFileId');
      const responseSha256 = textField(payload, 'responseSha256');
      const byteLength = payload.byteLength;
      if (
        !storageFileId ||
        responseSha256 !== payloadId ||
        payload.endpointId !== 'product.get' ||
        payload.status !== 'stored' ||
        typeof byteLength !== 'number' ||
        !Number.isSafeInteger(byteLength) ||
        byteLength < 0
      ) {
        failures.push({ sourceKey, reason: 'invalid-payload-metadata' });
        continue;
      }
      if (byteLength > MAX_RAW_BYTES) {
        failures.push({ sourceKey, reason: 'raw-too-large' });
        continue;
      }

      let bytes: Buffer;
      try {
        const stored = await port.readObjectAsBase64(storageFileId);
        bytes = Buffer.from(stored.body, 'base64');
      } catch {
        failures.push({ sourceKey, reason: 'raw-read-failed' });
        continue;
      }
      if (bytes.byteLength > MAX_RAW_BYTES) {
        failures.push({ sourceKey, reason: 'raw-too-large' });
        continue;
      }
      if (bytes.byteLength !== byteLength) {
        failures.push({ sourceKey, reason: 'raw-size-mismatch' });
        continue;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== payloadId) {
        failures.push({ sourceKey, reason: 'raw-hash-mismatch' });
        continue;
      }
      const envelope = parseAlibabaApiResponse(bytes.toString('utf8'));
      if (envelope.kind === 'malformed') {
        failures.push({ sourceKey, reason: 'malformed-response' });
        continue;
      }
      if (envelope.kind === 'api-error') {
        failures.push({ sourceKey, reason: 'provider-api-error' });
        continue;
      }
      const detail = extractProductDetail(envelope.root);
      if (!detail.sourceProductId) {
        failures.push({ sourceKey, reason: 'missing-product-id' });
        continue;
      }
      if (detail.sourceProductId !== sourceProductId) {
        failures.push({ sourceKey, reason: 'product-id-mismatch' });
        continue;
      }
      const normalized = normalizeProductDetail({
        connectionId,
        detail,
        payloadId,
        now: observedAt,
      });
      if (!normalized.ok) {
        failures.push({ sourceKey, reason: 'missing-product-id' });
        continue;
      }
      if (normalized.sourceProduct.sourceKey !== sourceKey) {
        failures.push({ sourceKey, reason: 'source-key-mismatch' });
        continue;
      }
      const existingOffers = await port.listActiveOffers(sourceKey);
      const existingKeys = existingOffers.map((offer) => offer._id).sort();
      const replayKeys = normalized.offers.map((offer) => offer.offerKey).sort();
      if (!sameKeys(existingKeys, replayKeys)) {
        failures.push({ sourceKey, reason: 'offer-set-mismatch' });
        continue;
      }
      const captureMode = lastSeenRunId.startsWith('full-') ? 'full' : 'incremental';
      const observationBatch = alibabaObservationAdapter.toObservations({
        connectionId,
        detail,
        payloadId,
        observedAt,
        captureMode,
      });
      const observation = observationBatch.observations[0];
      if (
        observation === undefined ||
        observationBatch.findings.some((finding) => finding.severity === 'error')
      ) {
        failures.push({ sourceKey, reason: 'invalid-source-observation' });
        continue;
      }
      plans.push({
        source,
        payloadId,
        firstSeenOperationId: firstSeenRunId,
        lastSeenOperationId: lastSeenRunId,
        normalized,
        observation,
      });
    }

    const pageHash = pageFingerprint(plans, afterSourceKey, totalSourceProducts);
    if (!(await port.renewLease(holder, grant.fence))) {
      return { ok: false, reason: 'lease-lost' };
    }

    let applied = 0;
    if (input.mode === 'apply' && failures.length === 0) {
      if (input.expectedPageHash !== pageHash) {
        return { ok: false, reason: 'page-changed' };
      }
      for (const plan of plans) {
        if (!(await port.renewLease(holder, grant.fence))) {
          return { ok: false, reason: 'lease-lost' };
        }
        for (const offer of plan.normalized.offers) {
          const updated = await port.updateOffer(
            offer.offerKey,
            { sourceAttributes: offer.sourceAttributes },
            {
              connectionId: PRIMARY_CONNECTION_ID,
              holder,
              fence: grant.fence,
              now: port.now(),
            },
          );
          if (!updated) return { ok: false, reason: 'lease-lost' };
        }
        const observationWritten = await port.upsertObservation(
          sourceObservationDocumentId('alibaba', plan.source._id),
          {
            provider: 'alibaba',
            sourceProductKey: plan.source._id,
            externalProductId: plan.normalized.sourceProduct.sourceProductId,
            schemaVersion: plan.observation.schemaVersion,
            observedAt: plan.observation.source.observedAt,
            ...(plan.observation.source.sourceUpdatedAt === undefined
              ? {}
              : { sourceUpdatedAt: plan.observation.source.sourceUpdatedAt }),
            evidenceId: plan.payloadId,
            active: true,
            observation: plan.observation,
            lastSeenOperationId: plan.lastSeenOperationId,
          },
          { firstSeenOperationId: plan.firstSeenOperationId },
          {
            connectionId: PRIMARY_CONNECTION_ID,
            holder,
            fence: grant.fence,
            now: port.now(),
          },
        );
        if (!observationWritten) return { ok: false, reason: 'lease-lost' };
        applied += 1;
      }
    }

    const counts: AlibabaRawReplayCounts = {
      sourceProducts: rows.length,
      observations: plans.length,
      variants: plans.reduce((total, plan) => total + plan.observation.variants.length, 0),
      offers: plans.reduce((total, plan) => total + plan.observation.offers.length, 0),
      attributedVariants: plans.reduce(
        (total, plan) =>
          total + plan.observation.variants.filter((variant) => variant.options.length > 0).length,
        0,
      ),
      attributePairs: plans.reduce(
        (total, plan) =>
          total +
          plan.observation.variants.reduce(
            (variantTotal, variant) => variantTotal + variant.options.length,
            0,
          ),
        0,
      ),
      warnings: plans.reduce((total, plan) => total + plan.observation.warnings.length, 0),
    };
    const priceModes: Record<string, number> = {};
    for (const plan of plans) {
      for (const offer of plan.observation.offers) {
        priceModes[offer.pricing.mode] = (priceModes[offer.pricing.mode] ?? 0) + 1;
      }
    }
    const last = rows.at(-1)?._id ?? afterSourceKey;
    return {
      ok: true,
      mode: input.mode,
      ready: failures.length === 0,
      pageHash,
      totalSourceProducts,
      afterSourceKey,
      nextSourceKey: last,
      done: rows.length < limit,
      counts,
      priceModes,
      failures,
      applied,
    };
  } finally {
    await port.releaseLease(holder, grant.fence);
  }
}
