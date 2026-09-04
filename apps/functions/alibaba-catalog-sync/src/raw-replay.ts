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
const REPLAY_MANIFEST_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_REPLAY_MANIFEST_PAGES = 200;
const MANIFEST_ID_PATTERN =
  /^raw-replay-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  getReplayManifest(id: string): Promise<CollectionDoc | null>;
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
  upsertReplayManifest(
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
  getReplayManifest: (id) => get('alibabaRawReplayManifests', id),
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
  upsertReplayManifest: (id, value, createOnly, guard) =>
    upsertDocWithAlibabaLease('alibabaRawReplayManifests', id, value, createOnly, guard),
};

export interface AlibabaRawReplayInput {
  mode: 'dry-run' | 'apply';
  afterSourceKey?: string;
  limit?: number;
  expectedPageHash?: string;
  expectedTotalSourceProducts?: number;
  manifestId?: string;
  /** Bound by the authenticated handler; defaults only for direct internal calls/tests. */
  requestedBy?: string;
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
      reason:
        | 'invalid-input'
        | 'manifest-invalid'
        | 'lease-busy'
        | 'lease-corrupt'
        | 'lease-lost'
        | 'page-changed';
    }
  | {
      ok: true;
      mode: 'dry-run' | 'apply';
      ready: boolean;
      manifestId: string;
      manifestReady: boolean;
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

interface ReplayManifestPage {
  afterSourceKey: string;
  nextSourceKey: string;
  pageHash: string;
  limit: number;
  sourceProducts: number;
}

interface ReplayManifest {
  requestedBy: string;
  status: 'collecting' | 'ready' | 'applying' | 'applied' | 'failed';
  totalSourceProducts: number;
  pages: ReplayManifestPage[];
  nextApplyIndex: number;
  createdAt: string;
  expiresAt: string;
}

function textField(doc: CollectionDoc, field: string): string | null {
  const value = doc[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function canonicalInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
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

function parseReplayManifest(doc: CollectionDoc | null, now: string): ReplayManifest | null {
  if (!doc || !Array.isArray(doc.pages)) return null;
  const createdAtMs = canonicalInstantMs(doc.createdAt);
  const expiresAtMs = canonicalInstantMs(doc.expiresAt);
  const nowMs = canonicalInstantMs(now);
  if (
    doc.connectionId !== PRIMARY_CONNECTION_ID ||
    typeof doc.requestedBy !== 'string' ||
    doc.requestedBy.trim() === '' ||
    !['collecting', 'ready', 'applying', 'applied', 'failed'].includes(String(doc.status)) ||
    !Number.isSafeInteger(doc.totalSourceProducts) ||
    Number(doc.totalSourceProducts) < 0 ||
    !Number.isSafeInteger(doc.nextApplyIndex) ||
    Number(doc.nextApplyIndex) < 0 ||
    createdAtMs === null ||
    expiresAtMs === null ||
    nowMs === null ||
    createdAtMs > nowMs ||
    expiresAtMs - createdAtMs !== REPLAY_MANIFEST_TTL_MS ||
    expiresAtMs <= nowMs ||
    doc.pages.length > MAX_REPLAY_MANIFEST_PAGES
  ) {
    return null;
  }
  const pages: ReplayManifestPage[] = [];
  for (const value of doc.pages) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('afterSourceKey' in value) ||
      typeof value.afterSourceKey !== 'string' ||
      !('nextSourceKey' in value) ||
      typeof value.nextSourceKey !== 'string' ||
      !('pageHash' in value) ||
      typeof value.pageHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.pageHash) ||
      !('limit' in value) ||
      !Number.isSafeInteger(value.limit) ||
      Number(value.limit) < 1 ||
      Number(value.limit) > 20 ||
      !('sourceProducts' in value) ||
      !Number.isSafeInteger(value.sourceProducts) ||
      Number(value.sourceProducts) < 0 ||
      Number(value.sourceProducts) > Number(value.limit)
    ) {
      return null;
    }
    pages.push({
      afterSourceKey: value.afterSourceKey,
      nextSourceKey: value.nextSourceKey,
      pageHash: value.pageHash,
      limit: Number(value.limit),
      sourceProducts: Number(value.sourceProducts),
    });
  }
  if (
    pages.some(
      (page, index) =>
        page.afterSourceKey !== (index === 0 ? '' : pages[index - 1]?.nextSourceKey) ||
        (page.sourceProducts > 0 && page.nextSourceKey <= page.afterSourceKey),
    ) ||
    Number(doc.nextApplyIndex) > pages.length
  ) {
    return null;
  }
  const status = String(doc.status) as ReplayManifest['status'];
  if (status === 'ready' || status === 'applying' || status === 'applied') {
    const covered = pages.reduce((total, page) => total + page.sourceProducts, 0);
    const last = pages.at(-1);
    if (
      !last ||
      last.sourceProducts >= last.limit ||
      pages.slice(0, -1).some((page) => page.sourceProducts !== page.limit) ||
      covered !== Number(doc.totalSourceProducts)
    ) {
      return null;
    }
  }
  const nextApplyIndex = Number(doc.nextApplyIndex);
  if (
    ((status === 'collecting' || status === 'ready' || status === 'failed') &&
      nextApplyIndex !== 0) ||
    (status === 'applying' && (nextApplyIndex < 1 || nextApplyIndex >= pages.length)) ||
    (status === 'applied' && nextApplyIndex !== pages.length)
  ) {
    return null;
  }
  return {
    requestedBy: doc.requestedBy,
    status,
    totalSourceProducts: Number(doc.totalSourceProducts),
    pages,
    nextApplyIndex,
    createdAt: doc.createdAt as string,
    expiresAt: doc.expiresAt as string,
  };
}

function manifestCreateFields(
  requestedBy: string,
  totalSourceProducts: number,
  now: string,
): Record<string, unknown> {
  return {
    connectionId: PRIMARY_CONNECTION_ID,
    requestedBy,
    totalSourceProducts,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + REPLAY_MANIFEST_TTL_MS).toISOString(),
  };
}

export async function replayAlibabaRawPage(
  input: AlibabaRawReplayInput,
  port: AlibabaRawReplayPort = defaultPort,
): Promise<AlibabaRawReplayResult> {
  const limit = input.limit ?? 10;
  const afterSourceKey = input.afterSourceKey ?? '';
  const requestedBy = input.requestedBy?.trim() || 'internal-admin';
  if (
    requestedBy === '' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (input.manifestId !== undefined && !MANIFEST_ID_PATTERN.test(input.manifestId)) ||
    (input.mode === 'dry-run' && input.manifestId === undefined && afterSourceKey !== '') ||
    (input.mode === 'apply' &&
      (input.manifestId === undefined ||
        !/^[0-9a-f]{64}$/.test(input.expectedPageHash ?? '') ||
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
    const manifestId = input.manifestId ?? `raw-replay-${randomUUID()}`;
    const existingManifest =
      input.manifestId === undefined
        ? null
        : parseReplayManifest(await port.getReplayManifest(manifestId), port.now());
    if (input.manifestId !== undefined && existingManifest === null) {
      return { ok: false, reason: 'manifest-invalid' };
    }
    if (existingManifest && existingManifest.requestedBy !== requestedBy) {
      return { ok: false, reason: 'manifest-invalid' };
    }
    if (input.mode === 'dry-run' && existingManifest) {
      const expectedCursor = existingManifest.pages.at(-1)?.nextSourceKey ?? '';
      if (existingManifest.status !== 'collecting' || expectedCursor !== afterSourceKey) {
        return { ok: false, reason: 'manifest-invalid' };
      }
    }
    const requestedApplyIndex =
      input.mode === 'apply' && existingManifest
        ? existingManifest.pages.findIndex((page) => page.afterSourceKey === afterSourceKey)
        : -1;
    const applyPage =
      requestedApplyIndex >= 0 ? existingManifest?.pages[requestedApplyIndex] : undefined;
    const applyAlreadyCommitted =
      input.mode === 'apply' &&
      existingManifest !== null &&
      requestedApplyIndex >= 0 &&
      requestedApplyIndex < existingManifest.nextApplyIndex;
    if (
      input.mode === 'apply' &&
      (!existingManifest ||
        !['ready', 'applying', 'applied'].includes(existingManifest.status) ||
        !applyPage ||
        requestedApplyIndex > existingManifest.nextApplyIndex ||
        (requestedApplyIndex === existingManifest.nextApplyIndex &&
          existingManifest.status === 'applied') ||
        applyPage.limit !== limit ||
        applyPage.pageHash !== input.expectedPageHash ||
        existingManifest.totalSourceProducts !== input.expectedTotalSourceProducts)
    ) {
      return { ok: false, reason: 'manifest-invalid' };
    }
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
    if (existingManifest && existingManifest.totalSourceProducts !== totalSourceProducts) {
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
    const nextSourceKey = rows.at(-1)?._id ?? afterSourceKey;
    const done = rows.length < limit;
    let manifestReady = input.mode === 'apply';
    if (input.mode === 'dry-run') {
      const previousPages = existingManifest?.pages ?? [];
      const pages =
        failures.length === 0
          ? [
              ...previousPages,
              {
                afterSourceKey,
                nextSourceKey,
                pageHash,
                limit,
                sourceProducts: rows.length,
              },
            ]
          : previousPages;
      const covered = pages.reduce((total, page) => total + page.sourceProducts, 0);
      manifestReady = failures.length === 0 && done && covered === totalSourceProducts;
      const manifestFailed = failures.length > 0 || (done && covered !== totalSourceProducts);
      const manifestWriteNow = port.now();
      const persisted = await port.upsertReplayManifest(
        manifestId,
        {
          status: manifestFailed ? 'failed' : manifestReady ? 'ready' : 'collecting',
          totalSourceProducts,
          pages,
          nextApplyIndex: 0,
          expiresAt:
            existingManifest?.expiresAt ??
            new Date(Date.parse(manifestWriteNow) + REPLAY_MANIFEST_TTL_MS).toISOString(),
        },
        manifestCreateFields(requestedBy, totalSourceProducts, manifestWriteNow),
        {
          connectionId: PRIMARY_CONNECTION_ID,
          holder,
          fence: grant.fence,
          now: manifestWriteNow,
        },
      );
      if (!persisted) return { ok: false, reason: 'lease-lost' };
    }

    let applied = applyAlreadyCommitted && failures.length === 0 ? plans.length : 0;
    if (input.mode === 'apply' && failures.length === 0) {
      if (input.expectedPageHash !== pageHash) {
        return { ok: false, reason: 'page-changed' };
      }
      for (const plan of applyAlreadyCommitted ? [] : plans) {
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
      if (!applyAlreadyCommitted) {
        const nextApplyIndex = (existingManifest?.nextApplyIndex ?? 0) + 1;
        const applyComplete = nextApplyIndex >= (existingManifest?.pages.length ?? 0);
        const manifestAdvanced = await port.upsertReplayManifest(
          manifestId,
          {
            status: applyComplete ? 'applied' : 'applying',
            nextApplyIndex,
          },
          {},
          {
            connectionId: PRIMARY_CONNECTION_ID,
            holder,
            fence: grant.fence,
            now: port.now(),
          },
        );
        if (!manifestAdvanced) return { ok: false, reason: 'lease-lost' };
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
    return {
      ok: true,
      mode: input.mode,
      ready: failures.length === 0,
      manifestId,
      manifestReady,
      pageHash,
      totalSourceProducts,
      afterSourceKey,
      nextSourceKey,
      done,
      counts,
      priceModes,
      failures,
      applied,
    };
  } finally {
    await port.releaseLease(holder, grant.fence);
  }
}
