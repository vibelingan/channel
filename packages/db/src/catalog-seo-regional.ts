import { createHash, timingSafeEqual } from 'node:crypto';
import cloudbase from '@cloudbase/node-sdk';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { CatalogPublicHeadSchema, catalogPublicRecordId } from './catalog-public-changes.ts';
import type { CatalogPublicChangeStore } from './catalog-public-changes.ts';
import { seedCatalogSeoRequests } from './catalog-seo-bootstrap.ts';
import { createCatalogSeoStore } from './catalog-seo-cloud.ts';
import type { CatalogSeoDatabase } from './catalog-seo-cloud.ts';
import { consumeCatalogSeoRequest } from './catalog-seo-consumer.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import { catalogSeoControlId, readCatalogSeoControl } from './catalog-seo-control.ts';
import {
  CatalogSeoRecordingConfigSchema,
  CatalogSeoRequestSchema,
} from './catalog-seo-requests.ts';

declare const __REGIONAL_SHA__: string;
const environment = 'diversity-123-d9grnqfux221323bb';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
const counter = z.number().int().nonnegative().safe();
const guardSchema = z
  .object({ targetId: hash, ownerRunId: id, fence: counter.min(1), acquiredVersion: counter })
  .strict();
const ticketSchema = z
  .object({ owner: id, fence: counter.min(1), products: z.array(id).max(12) })
  .strict();
const common = z.object({
  schemaVersion: z.literal(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().regex(/^site-[1-9][0-9]*-[1-9][0-9]*$/),
  targetId: hash,
  siteOrigin: CatalogSeoRecordingConfigSchema.shape.siteOrigin,
  executorCodeSha: z.string().regex(/^[a-f0-9]{40}$/),
  requestId: id,
  guard: guardSchema,
});
const empty = z.object({}).strict();
const expectedWrites = { expectedWrites: counter };
const action = <T extends string, S extends z.ZodTypeAny>(name: T, input: S) =>
  common.extend({ action: z.literal(name), input }).strict();
export const CatalogRegionalRequestSchema = z.discriminatedUnion('action', [
  action('health', empty),
  action(
    'seed',
    z.object({ productIds: z.array(id).max(16), detailEnabled: z.boolean() }).strict(),
  ),
  action(
    'prepare.step',
    z.object({ maxItems: z.number().int().min(1).max(4), detailEnabled: z.boolean() }).strict(),
  ),
  action('delivery.check', z.object(expectedWrites).strict()),
  action(
    'delivery.begin',
    z.object({ ...expectedWrites, products: z.array(id).max(12), discovery: z.boolean() }).strict(),
  ),
  action(
    'delivery.end',
    z
      .object({ ...expectedWrites, ticket: ticketSchema, outcome: z.enum(['verified', 'unknown']) })
      .strict(),
  ),
  action(
    'delivery.accept',
    z
      .object({
        ...expectedWrites,
        expectedHeads: z.array(CatalogPublicHeadSchema).max(2),
        pages: z.array(z.object({ productId: id, htmlSha256: hash.nullable() }).strict()).max(2),
      })
      .strict(),
  ),
  action(
    'delivery.retry',
    z.object({ ...expectedWrites, productIds: z.array(id).max(2) }).strict(),
  ),
  action('operation.get', z.object({ requestId: id, inputHash: hash }).strict()),
]);
export type CatalogRegionalRequest = z.infer<typeof CatalogRegionalRequestSchema>;
export type CatalogRegionalConfig = {
  envId: string;
  runId: string;
  targetId: string;
  siteOrigin: string;
  codeSha: string;
  tokenDigest: string;
  runnerRef: string;
};
type JsonResult = Record<string, unknown>;
type RegionalResponse = {
  purpose: string;
  codeSha: string;
  runId: string;
  requestId: string;
  action: string;
} & (
  | { ok: true; result: JsonResult; error?: never }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        diagnostic?: { sdkCode?: string; requestId?: string };
      };
      result?: never;
    }
);
export type CatalogRegionalDelivery = {
  check(): Promise<unknown>;
  begin(products: readonly string[], discovery: boolean): Promise<JsonResult>;
  end(ticket: z.infer<typeof ticketSchema>, outcome: 'verified' | 'unknown'): Promise<unknown>;
  accept(
    pages: readonly { productId: string; htmlSha256: string | null }[],
    heads: readonly z.infer<typeof CatalogPublicHeadSchema>[],
  ): Promise<unknown>;
  retryKnownFailure(products: readonly string[]): Promise<unknown>;
};
type Dependencies = {
  createStore: () => CatalogSeoStore;
  createDelivery: (
    store: CatalogSeoStore,
    siteOrigin: string,
    writes: number,
    runId: string,
    clock: () => string,
  ) => CatalogRegionalDelivery;
  now?: () => number;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Schema parsing fixes key order, so callers share this exact request hash instead of inventing one. */
export function catalogRegionalRequestHash(input: unknown) {
  const { token: _token, ...request } = CatalogRegionalRequestSchema.parse(input);
  return digest(JSON.stringify(request));
}
export function catalogRegionalReceiptId(runId: string, requestId: string, unit?: number) {
  return `region-op-${digest(JSON.stringify([runId, requestId, unit ?? 'completed']))}`;
}

/** A regional worker can change only SEO records under the caller's current release lease. */
export function createCatalogRegionalHandler(
  config: CatalogRegionalConfig,
  dependencies: Dependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (input: unknown): Promise<RegionalResponse> => {
    let request: CatalogRegionalRequest | undefined;
    try {
      request = CatalogRegionalRequestSchema.parse(input);
      authorize(request, config);
      const currentRequest = request;
      const success = (result: JsonResult): RegionalResponse => ({
        purpose: 'catalog-seo-regional-v1',
        codeSha: config.codeSha,
        runId: config.runId,
        requestId: currentRequest.requestId,
        action: currentRequest.action,
        ok: true,
        result,
      });
      if (request.action === 'health')
        return success({ codeSha: config.codeSha, runId: config.runId });
      // No SDK/database initialization is allowed before the fixed identity and token checks.
      const store = dependencies.createStore();
      const inputHash = catalogRegionalRequestHash(request);
      const receiptId = catalogRegionalReceiptId(request.runId, request.requestId);
      if (request.action === 'operation.get') {
        const result = await operationStatus(
          store,
          config,
          request,
          request.input.requestId,
          request.input.inputHash,
          now(),
        );
        return success(result);
      }
      const previous = await store.get('catalogSeoBuilders', receiptId);
      if (previous) {
        await assertCurrentLease(store, request, config, now());
        const result = readReceipt(previous, request.runId, request.requestId, inputHash);
        if (request.action === 'delivery.begin')
          await assertBeginStillOwned(store, config.siteOrigin, result);
        return success(result);
      }
      let tail: Promise<unknown> = Promise.resolve();
      let unit = 0;
      const atomicDelivery =
        request.action.startsWith('delivery.') && request.action !== 'delivery.check';
      const guarded: CatalogSeoStore = {
        get: store.get.bind(store),
        list: store.list.bind(store),
        transaction: <T>(operation: (tx: CatalogPublicChangeStore) => Promise<T>): Promise<T> => {
          const index = unit++;
          const next = tail.then(() =>
            store.transaction(async (tx) => {
              const target = await tx.get('siteReleaseTargets', config.targetId);
              assertLease(target, currentRequest, config, now());
              const operationId = atomicDelivery
                ? receiptId
                : catalogRegionalReceiptId(config.runId, currentRequest.requestId, index);
              const existing = await tx.get('catalogSeoBuilders', operationId);
              if (existing) {
                const result = readReceipt(
                  existing,
                  config.runId,
                  currentRequest.requestId,
                  inputHash,
                );
                if (currentRequest.action === 'delivery.begin')
                  await assertBeginStillOwned(tx, config.siteOrigin, result);
                return existing.value as T;
              }
              const writes: { collection: string; row: CollectionDoc }[] = [];
              let writing = false;
              const value = await operation({
                get: (collection, key) => {
                  if (writing) throw new RegionalError('REGIONAL_READ_AFTER_WRITE');
                  return tx.get(collection, key);
                },
                set: async (collection, row) => {
                  if (!seoWrites.has(collection)) throw new RegionalError('REGIONAL_WRITE_SCOPE');
                  writing = true;
                  writes.push({ collection, row: structuredClone(row) });
                },
              });
              assertLease(target, currentRequest, config, now());
              const result = atomicDelivery
                ? deliveryResult(currentRequest, value)
                : { value: value ?? null };
              assertResultSize(result);
              // Writing the unchanged target makes a stale owner conflict with lease renewal/release.
              await tx.set('siteReleaseTargets', target);
              for (const write of writes) await tx.set(write.collection, write.row);
              await tx.set('catalogSeoBuilders', {
                ...receipt(operationId, currentRequest, inputHash, result, now()),
                value: value ?? null,
              });
              return value;
            }),
          );
          tail = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        },
      };
      await assertCurrentLease(store, request, config, now());
      const started = now();
      const clock = () => new Date(now()).toISOString();
      const recording = {
        siteOrigin: config.siteOrigin,
        detailEnabled: 'detailEnabled' in request.input ? request.input.detailEnabled : false,
      };
      let result: JsonResult;
      if (request.action === 'seed') {
        result = await seedCatalogSeoRequests(
          guarded,
          recording,
          request.input.productIds,
          clock(),
        );
      } else if (request.action === 'prepare.step') {
        let processed = 0;
        while (processed < request.input.maxItems && now() - started < 15_000) {
          const pending = await guarded.list(
            'catalogSeoRequests',
            { siteOrigin: config.siteOrigin, state: 'pending' },
            null,
            1,
          );
          if (!pending.length) break;
          await consumeCatalogSeoRequest(
            guarded,
            CatalogSeoRequestSchema.parse(pending[0]),
            recording,
            clock(),
          );
          processed++;
        }
        const pending = await guarded.list(
          'catalogSeoRequests',
          { siteOrigin: config.siteOrigin, state: 'pending' },
          null,
          1,
        );
        result = { ready: false, processed, elapsedMs: now() - started };
        if (!pending.length && now() - started < 15_000) {
          try {
            const capture = await captureHeads(guarded, config.siteOrigin, clock);
            result = {
              ready: true,
              processed,
              writes: capture.writes,
              heads: capture.heads,
              elapsedMs: now() - started,
            };
          } catch (error) {
            if (!(error instanceof RegionalError && error.code === 'REGIONAL_NOT_SETTLED'))
              throw error;
          }
        }
      } else {
        const delivery = dependencies.createDelivery(
          guarded,
          config.siteOrigin,
          request.input.expectedWrites,
          config.runId,
          clock,
        );
        switch (request.action) {
          case 'delivery.check':
            await delivery.check();
            result = { checked: true };
            break;
          case 'delivery.begin':
            result = await delivery.begin(request.input.products, request.input.discovery);
            break;
          case 'delivery.end':
            await delivery.end(request.input.ticket, request.input.outcome);
            result = { ended: true };
            break;
          case 'delivery.accept':
            await delivery.accept(request.input.pages, request.input.expectedHeads);
            result = { accepted: request.input.pages.length };
            break;
          case 'delivery.retry':
            await delivery.retryKnownFailure(request.input.productIds);
            result = { retried: request.input.productIds.length };
            break;
        }
      }
      await tail;
      assertResultSize(result);
      if (!atomicDelivery)
        await store.transaction(async (tx) => {
          const target = await tx.get('siteReleaseTargets', config.targetId);
          assertLease(target, currentRequest, config, now());
          const existing = await tx.get('catalogSeoBuilders', receiptId);
          if (existing) {
            readReceipt(existing, config.runId, currentRequest.requestId, inputHash);
            return;
          }
          await tx.set('siteReleaseTargets', target);
          await tx.set(
            'catalogSeoBuilders',
            receipt(receiptId, currentRequest, inputHash, result, now()),
          );
        });
      return success(result);
    } catch (error) {
      const code =
        error instanceof RegionalError
          ? error.code
          : error instanceof z.ZodError
            ? 'REGIONAL_INVALID_REQUEST'
            : error &&
                typeof error === 'object' &&
                Reflect.get(error, 'code') === 'STOP_CATALOG_CHANGE'
              ? 'STOP_CATALOG_CHANGE'
              : 'REGIONAL_OPERATION_FAILED';
      return {
        purpose: 'catalog-seo-regional-v1',
        codeSha: config.codeSha,
        runId: config.runId,
        requestId: request?.requestId ?? 'unknown',
        action: request?.action ?? 'unknown',
        ok: false,
        error: {
          code,
          message:
            code === 'REGIONAL_OPERATION_FAILED'
              ? 'Catalog operation failed. Read its receipt before continuing.'
              : code,
          diagnostic: safeDiagnostic(error),
        },
      };
    }
  };
}

const seoWrites = new Set([
  'catalogSeoRequests',
  'catalogPublicHeads',
  'catalogSeoTasks',
  'catalogSeoControl',
  'catalogSeoPages',
]);
class RegionalError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function safeDiagnostic(error: unknown): { sdkCode?: string; requestId?: string } {
  if (!error || typeof error !== 'object') return {};
  const sdkCode = Reflect.get(error, 'code');
  const requestId = Reflect.get(error, 'requestId');
  return {
    ...(typeof sdkCode === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(sdkCode)
      ? { sdkCode }
      : {}),
    ...(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(requestId)
      ? { requestId }
      : {}),
  };
}
function authorize(request: CatalogRegionalRequest, config: CatalogRegionalConfig) {
  if (
    config.envId !== environment ||
    request.runId !== config.runId ||
    request.targetId !== config.targetId ||
    request.guard.targetId !== config.targetId ||
    request.siteOrigin !== config.siteOrigin ||
    request.executorCodeSha !== config.codeSha ||
    !/^[a-f0-9]{64}$/.test(config.tokenDigest) ||
    !timingSafeEqual(
      Buffer.from(digest(request.token), 'hex'),
      Buffer.from(config.tokenDigest, 'hex'),
    )
  )
    throw new RegionalError('REGIONAL_UNAUTHORIZED');
}
function assertLease(
  target: CollectionDoc | null,
  request: CatalogRegionalRequest,
  config: CatalogRegionalConfig,
  now: number,
): asserts target is CollectionDoc {
  const parsed = z
    .object({
      _id: hash,
      schemaVersion: z.literal(1),
      targetId: hash,
      target: z.object({ envId: z.string(), siteOrigin: z.string() }).passthrough(),
      lease: z
        .object({
          ownerRunId: id,
          runnerRef: z.string(),
          fence: counter,
          acquiredVersion: counter,
          expiresAt: counter,
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(target);
  if (!parsed.success) throw new RegionalError('REGIONAL_LEASE_CHANGED');
  const t = parsed.data;
  if (
    t._id !== config.targetId ||
    t.targetId !== config.targetId ||
    t.target.envId !== config.envId ||
    t.target.siteOrigin !== config.siteOrigin ||
    t.lease.ownerRunId !== request.guard.ownerRunId ||
    t.lease.fence !== request.guard.fence ||
    t.lease.acquiredVersion !== request.guard.acquiredVersion ||
    t.lease.runnerRef !== config.runnerRef ||
    t.lease.expiresAt <= now
  )
    throw new RegionalError('REGIONAL_LEASE_CHANGED');
}
async function assertCurrentLease(
  store: CatalogSeoStore,
  request: CatalogRegionalRequest,
  config: CatalogRegionalConfig,
  now: number,
) {
  assertLease(await store.get('siteReleaseTargets', config.targetId), request, config, now);
}
async function captureHeads(store: CatalogSeoStore, siteOrigin: string, clock: () => string) {
  const control = () => store.get('catalogSeoControl', catalogSeoControlId(siteOrigin));
  const before = readCatalogSeoControl(await control(), siteOrigin, clock());
  const settled = async () => {
    const pending = await store.list(
      'catalogSeoRequests',
      { siteOrigin, state: 'pending' },
      null,
      1,
    );
    if (pending.length) throw new RegionalError('REGIONAL_NOT_SETTLED');
  };
  if (before.state !== 'idle') throw new RegionalError('REGIONAL_NOT_SETTLED');
  await settled();
  const heads: z.infer<typeof CatalogPublicHeadSchema>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.list('catalogPublicHeads', { siteOrigin }, cursor, 100);
    for (const row of rows) {
      const head = CatalogPublicHeadSchema.parse(row);
      if (
        head.siteOrigin !== siteOrigin ||
        head._id !== catalogPublicRecordId(siteOrigin, head.productId) ||
        head._id <= (cursor ?? '')
      )
        throw new RegionalError('REGIONAL_INVALID_HEAD');
      heads.push(head);
      cursor = head._id;
      if (heads.length > 50_000) throw new RegionalError('REGIONAL_RESULT_LIMIT');
    }
    if (rows.length < 100) break;
  }
  await settled();
  const after = readCatalogSeoControl(await control(), siteOrigin, clock());
  if (after.state !== 'idle' || after.writes !== before.writes)
    throw new RegionalError('REGIONAL_NOT_SETTLED');
  return { writes: after.writes, heads };
}
function deliveryResult(request: CatalogRegionalRequest, value: unknown): JsonResult {
  if (request.action === 'delivery.end') return { ended: true };
  if (request.action === 'delivery.accept') return { accepted: request.input.pages.length };
  if (request.action === 'delivery.retry') return { retried: request.input.productIds.length };
  if (
    request.action === 'delivery.begin' &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    return { ...value };
  throw new RegionalError('REGIONAL_RESULT_INVALID');
}
function assertResultSize(result: JsonResult) {
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024 - 1024)
    throw new RegionalError('REGIONAL_RESULT_LIMIT');
}
function receipt(
  _id: string,
  request: CatalogRegionalRequest,
  inputHash: string,
  result: JsonResult,
  now: number,
): CollectionDoc {
  return {
    _id,
    schemaVersion: 1,
    purpose: 'catalog-seo-regional-receipt',
    runId: request.runId,
    requestId: request.requestId,
    action: request.action,
    inputHash,
    result,
    completedAt: new Date(now).toISOString(),
  };
}
function readReceipt(
  row: CollectionDoc,
  runId: string,
  requestId: string,
  inputHash: string,
): JsonResult {
  const value = z
    .object({
      purpose: z.literal('catalog-seo-regional-receipt'),
      schemaVersion: z.literal(1),
      runId: z.literal(runId),
      requestId: z.literal(requestId),
      inputHash: z.literal(inputHash),
      result: z.record(z.unknown()),
      completedAt: z.string().datetime(),
    })
    .passthrough()
    .safeParse(row);
  if (!value.success) throw new RegionalError('REGIONAL_OPERATION_MISMATCH');
  return value.data.result;
}
async function operationStatus(
  store: CatalogSeoStore,
  config: CatalogRegionalConfig,
  request: CatalogRegionalRequest,
  requestId: string,
  inputHash: string,
  now: number,
): Promise<JsonResult> {
  const completed = await store.get(
    'catalogSeoBuilders',
    catalogRegionalReceiptId(config.runId, requestId),
  );
  if (completed) {
    const result = readReceipt(completed, config.runId, requestId, inputHash);
    if (completed.action === 'delivery.begin') {
      await assertCurrentLease(store, request, config, now);
      await assertBeginStillOwned(store, config.siteOrigin, result);
    }
    return { state: 'completed', receipt: { action: completed.action, result } };
  }
  const first = await store.get(
    'catalogSeoBuilders',
    catalogRegionalReceiptId(config.runId, requestId, 0),
  );
  if (first) {
    readReceipt(first, config.runId, requestId, inputHash);
    return { state: 'partial' };
  }
  return { state: 'not-found' };
}
async function assertBeginStillOwned(
  store: Pick<CatalogSeoStore, 'get'>,
  siteOrigin: string,
  result: JsonResult,
) {
  const ticket = ticketSchema.safeParse(result.ticket);
  const row = await store.get('catalogSeoControl', catalogSeoControlId(siteOrigin));
  if (
    !ticket.success ||
    row?.state !== 'writing' ||
    row.owner !== ticket.data.owner ||
    row.fence !== ticket.data.fence ||
    JSON.stringify(row.products) !== JSON.stringify(ticket.data.products)
  )
    throw new RegionalError('REGIONAL_TICKET_ENDED');
}

export async function main(event: unknown) {
  const config: CatalogRegionalConfig = {
    envId: process.env.TCB_ENV ?? '',
    runId: process.env.CATALOG_REGIONAL_RUN_ID ?? '',
    targetId: process.env.CATALOG_REGIONAL_TARGET_ID ?? '',
    siteOrigin: process.env.CATALOG_REGIONAL_SITE_ORIGIN ?? '',
    tokenDigest: process.env.CATALOG_REGIONAL_TOKEN_DIGEST ?? '',
    runnerRef: process.env.CATALOG_REGIONAL_RUNNER_REF ?? '',
    codeSha: typeof __REGIONAL_SHA__ === 'string' ? __REGIONAL_SHA__ : '',
  };
  const { createCatalogSeoDeliveryStateless } = await import('./catalog-seo-delivery.ts');
  return createCatalogRegionalHandler(config, {
    createStore: () =>
      createCatalogSeoStore(cloudbase.init({ env: config.envId }).database() as CatalogSeoDatabase),
    createDelivery: createCatalogSeoDeliveryStateless,
  })(event);
}
