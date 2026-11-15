import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import cloudbase from '@cloudbase/node-sdk';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import {
  CatalogPublicHeadSchema,
  CatalogSeoTaskSchema,
  catalogPublicRecordId,
} from './catalog-public-changes.ts';
import type { CatalogPublicChangeStore } from './catalog-public-changes.ts';
import { seedCatalogSeoRequests } from './catalog-seo-bootstrap.ts';
import { createCatalogSeoStore } from './catalog-seo-cloud.ts';
import type { CatalogSeoDatabase } from './catalog-seo-cloud.ts';
import { consumeCatalogSeoRequest } from './catalog-seo-consumer.ts';
import type { CatalogSeoStore } from './catalog-seo-consumer.ts';
import {
  catalogSeoControlId,
  idleCatalogSeoControl,
  readCatalogSeoControl,
} from './catalog-seo-control.ts';
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
const cleanupStates = ['leased', 'writing', 'needs-readback', 'control'] as const;
const artifactSchema = z
  .object({
    repository: z.literal('vibelingan/channel'),
    workflowPath: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    runId: z.string().regex(/^[1-9][0-9]*$/),
    artifactId: z.string().regex(/^[1-9][0-9]*$/),
    manifestSha256: hash,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const rendererSchema = z
  .object({
    codeSha: z.string().regex(/^[a-f0-9]{40}$/),
    manifestSha256: hash,
    archiveSha256: hash,
    archiveFileId: z.string().min(1).max(2000),
    inputSchema: z.literal(1),
  })
  .strict();
const activationInputSchema = z
  .object({
    artifact: artifactSchema,
    acceptedSeal: z.record(z.unknown()),
    renderer: rendererSchema,
    executorRef: z.enum(['feat/seo-foundation', 'test']),
    expectedWrites: counter,
  })
  .strict();
const recoveryInputSchema = z
  .object({
    stoppedRunId: z.string().regex(/^site-[1-9][0-9]*-[1-9][0-9]*$/),
    stepId: id,
    beginRequestId: id,
    endRequestId: id,
    originalWrites: counter,
    state: z.enum(cleanupStates),
    cursor: hash.nullable(),
  })
  .strict()
  .refine((value) => value.state !== 'control' || value.cursor === null);
const activeRendererSchema = z
  .object({
    codeSha: z.string().regex(/^[a-f0-9]{40}$/),
    manifestSha256: hash,
    executorSha: z.string().regex(/^[a-f0-9]{40}$/),
    executorRef: z.enum(['feat/seo-foundation', 'test']),
    acceptedRunId: z.string().regex(/^site-[1-9][0-9]*-[1-9][0-9]*$/),
    catalogTracked: z.literal(true),
  })
  .strict();
const action = <T extends string, S extends z.ZodTypeAny>(name: T, input: S) =>
  common.extend({ action: z.literal(name), input }).strict();
export const CatalogRegionalRequestSchema = z.discriminatedUnion('action', [
  action('health', empty),
  action('capture.read', empty),
  action('registration.activate', activationInputSchema),
  action('recovery.clear', recoveryInputSchema),
  action(
    'registration.clear',
    z
      .object({
        artifact: artifactSchema,
        acceptedSeal: z.record(z.unknown()),
        state: z.enum(cleanupStates),
        cursor: hash.nullable(),
      })
      .strict()
      .refine((value) => value.state !== 'control' || value.cursor === null),
  ),
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
          now,
        );
        return success(result);
      }
      if (request.action === 'capture.read') {
        await assertCurrentLease(store, request, config, now());
        const result = await captureHeads(store, config.siteOrigin, () =>
          new Date(now()).toISOString(),
        );
        await assertCurrentLease(store, request, config, now());
        assertResultSize(result);
        return success(result);
      }
      const previous = await store.get('catalogSeoBuilders', receiptId);
      if (previous) {
        await assertCurrentLease(store, request, config, now());
        const result = readReceipt(previous, request.runId, request.requestId, inputHash);
        if (request.action === 'delivery.begin')
          await assertBeginStillOwned(store, config.siteOrigin, result);
        if (request.action === 'registration.activate')
          await assertActivationReceiptCurrent(store, previous, request, config, now);
        if (request.action === 'recovery.clear')
          await assertRecoveryReceiptCurrent(store, previous, request, config, now);
        return success(result);
      }
      let tail: Promise<unknown> = Promise.resolve();
      let unit = 0;
      const atomicDelivery =
        (request.action.startsWith('delivery.') && request.action !== 'delivery.check') ||
        request.action === 'registration.clear' ||
        request.action === 'registration.activate' ||
        request.action === 'recovery.clear';
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
                if (currentRequest.action === 'registration.activate')
                  await assertActivationReceiptCurrent(tx, existing, currentRequest, config, now);
                if (currentRequest.action === 'recovery.clear')
                  await assertRecoveryReceiptCurrent(tx, existing, currentRequest, config, now);
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
                  if (
                    !seoWrites.has(collection) &&
                    !(
                      currentRequest.action === 'registration.activate' &&
                      collection === 'catalogSeoBuilders' &&
                      row._id === 'active'
                    ) &&
                    !(
                      currentRequest.action === 'recovery.clear' &&
                      collection === 'catalogSeoBuilders' &&
                      row._id === recoveryProgressId(currentRequest)
                    )
                  )
                    throw new RegionalError('REGIONAL_WRITE_SCOPE');
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
      if (request.action === 'registration.activate') {
        result = await activateAcceptedRenderer(guarded, request, config, now);
      } else if (request.action === 'registration.clear' || request.action === 'recovery.clear') {
        result = await clearRegistrationStep(guarded, request, config, clock, now);
      } else if (request.action === 'seed') {
        result = await seedCatalogSeoRequests(
          guarded,
          recording,
          request.input.productIds,
          clock(),
        );
      } else if (request.action === 'prepare.step') {
        await assertPreparationGate(guarded, config.siteOrigin, clock());
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
            await assertPreparationGate(guarded, config.siteOrigin, clock());
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
  store: Pick<CatalogSeoStore, 'get'>,
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
type RegistrationClearRequest = Extract<CatalogRegionalRequest, { action: 'registration.clear' }>;
type RecoveryClearRequest = Extract<CatalogRegionalRequest, { action: 'recovery.clear' }>;
type RegistrationActivateRequest = Extract<
  CatalogRegionalRequest,
  { action: 'registration.activate' }
>;

async function assertAcceptedRegistration(
  store: Pick<CatalogSeoStore, 'get'>,
  request: RegistrationClearRequest | RegistrationActivateRequest,
  config: CatalogRegionalConfig,
  now: number,
) {
  const target = await store.get('siteReleaseTargets', config.targetId);
  assertLease(target, request, config, now);
  const scope = await store.get('siteReleaseScopes', `${config.targetId}-site`);
  // This is the coordinator's canonical identity({targetId,runId}), not the literal run ID.
  const key = digest(JSON.stringify({ runId: config.runId, targetId: config.targetId }));
  const run = await store.get('siteReleaseRuns', key);
  const accepted = run?.accepted;
  const pointer = scope?.baseline;
  if (
    target.currentRunId !== null ||
    target.dirtyRunId !== null ||
    target.unresolvedOperation !== null ||
    scope?._id !== `${config.targetId}-site` ||
    scope.schemaVersion !== 1 ||
    scope.targetId !== config.targetId ||
    scope.scopeKey !== 'site' ||
    !isDeepStrictEqual(scope.scope, { kind: 'site' }) ||
    !isDeepStrictEqual(scope.active, pointer) ||
    !pointer ||
    typeof pointer !== 'object' ||
    Array.isArray(pointer) ||
    !run ||
    run._id !== key ||
    run.state !== 'SUCCEEDED' ||
    run.runId !== config.runId ||
    run.targetId !== config.targetId ||
    run.scopeKey !== 'site' ||
    !accepted ||
    typeof accepted !== 'object' ||
    Array.isArray(accepted) ||
    Reflect.get(accepted, 'sourceRunId') !== config.runId ||
    Reflect.get(pointer, 'sourceRunId') !== config.runId ||
    typeof Reflect.get(accepted, 'activationId') !== 'string' ||
    !id.safeParse(Reflect.get(accepted, 'activationId')).success ||
    Reflect.get(pointer, 'activationId') !== Reflect.get(accepted, 'activationId')
  )
    throw new RegionalError('REGIONAL_REGISTRATION_SOURCE_CHANGED');
  const composition = run.composition;
  const staticPart =
    composition && typeof composition === 'object' && !Array.isArray(composition)
      ? Reflect.get(composition, 'static')
      : null;
  const seals = Reflect.get(accepted, 'seals');
  const seal =
    seals && typeof seals === 'object' && !Array.isArray(seals)
      ? Reflect.get(seals, 'static')
      : null;
  if (
    !staticPart ||
    typeof staticPart !== 'object' ||
    Array.isArray(staticPart) ||
    !isDeepStrictEqual(Reflect.get(staticPart, 'artifact'), request.input.artifact) ||
    !seal ||
    !isDeepStrictEqual(seal, request.input.acceptedSeal)
  )
    throw new RegionalError('REGIONAL_REGISTRATION_SOURCE_CHANGED');
  return run;
}

/** This action has one fixed destination; caller data never becomes an arbitrary document. */
async function activateAcceptedRenderer(
  store: CatalogSeoStore,
  request: RegistrationActivateRequest,
  config: CatalogRegionalConfig,
  now: () => number,
): Promise<JsonResult> {
  return store.transaction(async (tx) => {
    const run = await assertAcceptedRegistration(tx, request, config, now());
    const renderer = request.input.renderer;
    const approved = await tx.get('catalogSeoBuilders', renderer.codeSha);
    if (
      approved?._id !== renderer.codeSha ||
      approved.schemaVersion !== 1 ||
      approved.codeSha !== renderer.codeSha ||
      approved.manifestSha256 !== renderer.manifestSha256 ||
      approved.archiveSha256 !== renderer.archiveSha256 ||
      approved.inputSchema !== 1 ||
      !approved.archiveObject ||
      typeof approved.archiveObject !== 'object' ||
      Array.isArray(approved.archiveObject) ||
      Reflect.get(approved.archiveObject, 'fileID') !== renderer.archiveFileId
    )
      throw new RegionalError('REGIONAL_RENDERER_NOT_APPROVED');
    const control = readCatalogSeoControl(
      await tx.get('catalogSeoControl', catalogSeoControlId(config.siteOrigin)),
      config.siteOrigin,
      new Date(now()).toISOString(),
    );
    if (control.state !== 'idle' || control.writes !== request.input.expectedWrites)
      throw new RegionalError('REGIONAL_NOT_SETTLED');
    const active = {
      codeSha: approved.codeSha,
      manifestSha256: approved.manifestSha256,
      executorSha: config.codeSha,
      executorRef: request.input.executorRef,
      acceptedRunId: config.runId,
      catalogTracked: true,
    };
    const previous = await tx.get('catalogSeoBuilders', 'active');
    if (previous) {
      const prior = activeRendererSchema
        .extend({ catalogTracked: z.boolean() })
        .parse(Object.fromEntries(Object.entries(previous).filter(([key]) => key !== '_id')));
      if (prior.acceptedRunId === config.runId) {
        if (prior.codeSha !== active.codeSha || prior.manifestSha256 !== active.manifestSha256)
          throw new RegionalError('REGIONAL_ACTIVATION_CHANGED');
      } else {
        const key = digest(
          JSON.stringify({ runId: prior.acceptedRunId, targetId: config.targetId }),
        );
        const older = await tx.get('siteReleaseRuns', key);
        if (
          older?.state !== 'SUCCEEDED' ||
          older.runId !== prior.acceptedRunId ||
          older.targetId !== config.targetId ||
          older.scopeKey !== 'site' ||
          !older.accepted ||
          typeof older.accepted !== 'object' ||
          Array.isArray(older.accepted) ||
          Reflect.get(older.accepted, 'sourceRunId') !== prior.acceptedRunId ||
          !counter.safeParse(older.baseScopeVersion).success ||
          !counter.safeParse(run.baseScopeVersion).success ||
          Number(older.baseScopeVersion) >= Number(run.baseScopeVersion)
        )
          throw new RegionalError('REGIONAL_ACTIVATION_CHANGED');
      }
    }
    await assertCurrentLease(tx, request, config, now());
    await tx.set('catalogSeoBuilders', { _id: 'active', ...active });
    return { registered: true, active };
  });
}

async function assertActivationReceiptCurrent(
  store: Pick<CatalogSeoStore, 'get'>,
  row: CollectionDoc,
  request: CatalogRegionalRequest,
  config: CatalogRegionalConfig,
  now: () => number,
) {
  const input = activationInputSchema.parse(row.activationInput);
  const original: RegistrationActivateRequest = {
    ...request,
    action: 'registration.activate',
    input,
  };
  await assertAcceptedRegistration(store, original, config, now());
  const result = z
    .object({ registered: z.literal(true), active: activeRendererSchema })
    .strict()
    .parse(row.result);
  const current = await store.get('catalogSeoBuilders', 'active');
  if (
    !current ||
    !isDeepStrictEqual(
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== '_id')),
      result.active,
    )
  )
    throw new RegionalError('REGIONAL_ACTIVATION_CHANGED');
  await assertCurrentLease(store, request, config, now());
}

async function assertPreparationGate(
  store: Pick<CatalogSeoStore, 'get'>,
  siteOrigin: string,
  clock: string,
) {
  const control = readCatalogSeoControl(
    await store.get('catalogSeoControl', catalogSeoControlId(siteOrigin)),
    siteOrigin,
    clock,
  );
  if (control.state !== 'idle')
    throw new RegionalError('REGIONAL_PREVIOUS_DELIVERY_NEEDS_READBACK');
}

// Matches the release ledger's canonical JSON identities; checked against actual coordinator records.
function ledgerIdentity(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(Reflect.get(item, key))]),
          )
        : item;
  return digest(JSON.stringify(sort(value)));
}
function recoveryProgressId(request: RecoveryClearRequest) {
  const { state: _state, cursor: _cursor, ...proof } = request.input;
  return `recovery-progress-${ledgerIdentity({ guard: request.guard, runId: request.runId, proof })}`;
}
function assertRecoveryProgress(row: CollectionDoc | null, request: RecoveryClearRequest) {
  const position = { state: request.input.state, cursor: request.input.cursor };
  if (row === null) {
    if (position.state !== 'leased' || position.cursor !== null)
      throw new RegionalError('REGIONAL_RECOVERY_CURSOR');
    return;
  }
  if (
    row._id !== recoveryProgressId(request) ||
    row.schemaVersion !== 1 ||
    row.purpose !== 'catalog-failed-recovery-progress' ||
    !(
      isDeepStrictEqual(row.next, position) ||
      (row.next === null && position.state === 'control' && position.cursor === null)
    )
  )
    throw new RegionalError('REGIONAL_RECOVERY_CURSOR');
}
function assertRecoveryControl(
  control: ReturnType<typeof readCatalogSeoControl>,
  ticket: z.infer<typeof ticketSchema>,
  originalWrites: number,
  now: number,
) {
  if (control.writes < originalWrites) throw new RegionalError('REGIONAL_RECOVERY_SOURCE_CHANGED');
  if (control.state === 'idle' && control.fence === ticket.fence + 1) return;
  if (
    control.state !== 'needs-readback' ||
    control.owner !== ticket.owner ||
    control.fence !== ticket.fence ||
    control.discovery ||
    !isDeepStrictEqual(control.products, ticket.products) ||
    !isDeepStrictEqual(control.families, ['headphones', 'ai-gadgets', 'toys', 'misc']) ||
    !control.until ||
    Date.parse(control.until) > now
  )
    throw new RegionalError('REGIONAL_RECOVERY_SOURCE_CHANGED');
}
async function assertFailedRecoverySource(
  store: Pick<CatalogSeoStore, 'get'>,
  request: RecoveryClearRequest,
  config: CatalogRegionalConfig,
  now: () => number,
) {
  const reject = () => {
    throw new RegionalError('REGIONAL_RECOVERY_SOURCE_CHANGED');
  };
  const input = request.input;
  const target = await store.get('siteReleaseTargets', config.targetId);
  assertLease(target, request, config, now());
  if (
    target.currentRunId !== null ||
    target.unresolvedOperation !== null ||
    target.dirtyRunId !== input.stoppedRunId ||
    request.guard.ownerRunId === input.stoppedRunId
  )
    reject();
  const runKey = ledgerIdentity({ targetId: config.targetId, runId: input.stoppedRunId });
  const parsedRun = z
    .object({
      _id: z.literal(runKey),
      schemaVersion: z.literal(1),
      targetId: z.literal(config.targetId),
      runId: z.literal(input.stoppedRunId),
      ownerRunId: z.literal(input.stoppedRunId),
      scopeKey: z.literal('site'),
      state: z.literal('FAILED'),
      kind: z.enum(['publish', 'reconcile']),
      accepted: z.null(),
      fence: counter.min(1),
      acquiredVersion: counter,
      baseScopeVersion: counter,
      verifiedSteps: counter,
      verifiedWrites: counter,
      deliveredComponents: z.tuple([z.literal('static')]),
      plan: z.object({ planSha256: hash, stepCount: counter.min(2) }).passthrough(),
      composition: z
        .object({
          static: z
            .object({ codeSha: z.string().regex(/^[a-f0-9]{40}$/), artifact: artifactSchema })
            .passthrough(),
        })
        .strict(),
      reconciliation: z.record(z.unknown()),
    })
    .passthrough()
    .safeParse(await store.get('siteReleaseRuns', runKey));
  if (!parsedRun.success) return reject();
  const run = parsedRun.data;
  const match = /^site-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(run.runId);
  if (
    !match ||
    run.composition.static.artifact.runId !== match[1] ||
    request.guard.fence <= run.fence ||
    request.guard.acquiredVersion <= run.acquiredVersion
  )
    return reject();
  const scope = await store.get('siteReleaseScopes', `${config.targetId}-site`);
  if (
    scope?._id !== `${config.targetId}-site` ||
    scope.schemaVersion !== 1 ||
    scope.targetId !== config.targetId ||
    scope.scopeKey !== 'site' ||
    !isDeepStrictEqual(scope.scope, { kind: 'site' }) ||
    !scope.baseline ||
    typeof scope.baseline !== 'object' ||
    Array.isArray(scope.baseline) ||
    !id.safeParse(Reflect.get(scope.baseline, 'sourceRunId')).success ||
    Reflect.get(scope.baseline, 'sourceRunId') === run.runId ||
    !isDeepStrictEqual(scope.active, scope.baseline) ||
    scope.version !== run.baseScopeVersion
  )
    reject();
  const stepKey = ledgerIdentity({
    targetId: config.targetId,
    runId: run.runId,
    stepId: input.stepId,
  });
  const parsedStep = z
    .object({
      _id: z.literal(stepKey),
      schemaVersion: z.literal(1),
      targetId: z.literal(config.targetId),
      runId: z.literal(run.runId),
      stepId: z.literal(input.stepId),
      operationId: id,
      component: z.literal('static'),
      kind: z.literal('write'),
      beforeHash: hash,
      afterHash: hash,
      subject: z.string(),
      verifySubject: z.string(),
      executionId: id,
      planSha256: z.literal(run.plan.planSha256),
      sequence: z.literal(run.verifiedSteps),
      fence: z.literal(run.fence),
      members: z
        .array(
          z
            .object({
              path: z.string().regex(/^products\/p-([A-Za-z0-9_-]{1,200})\/index\.html$/),
              bytes: counter.max(128 * 1024 * 1024),
              sha256: hash,
              beforeHash: z.union([hash, z.literal('absent')]),
            })
            .passthrough(),
        )
        .min(1)
        .max(12),
      intentHash: hash,
      state: z.literal('reconciled'),
      resolution: z.record(z.unknown()),
    })
    .passthrough()
    .safeParse(await store.get('siteReleaseSteps', stepKey));
  if (!parsedStep.success) return reject();
  const step = parsedStep.data;
  const intentKeys = [
    'schemaVersion',
    'targetId',
    'runId',
    'stepId',
    'operationId',
    'component',
    'kind',
    'beforeHash',
    'afterHash',
    'subject',
    'verifySubject',
    'executionId',
    'planSha256',
    'sequence',
    'fence',
    'members',
  ];
  if (
    Object.hasOwn(step, 'removals') ||
    run.verifiedWrites !== run.verifiedSteps ||
    step.sequence >= run.plan.stepCount - 1 ||
    step.intentHash !==
      ledgerIdentity(Object.fromEntries(intentKeys.map((key) => [key, Reflect.get(step, key)]))) ||
    step.beforeHash !==
      ledgerIdentity(step.members.map(({ path, beforeHash }) => ({ path, beforeHash }))) ||
    step.afterHash !==
      ledgerIdentity(step.members.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))) ||
    step.subject !== `upload-batch:${step.afterHash}` ||
    step.verifySubject !== `read-batch:${step.afterHash}` ||
    new Set(step.members.map((member) => member.path)).size !== step.members.length ||
    !isDeepStrictEqual(step.resolution, run.reconciliation)
  )
    reject();
  const proof = z
    .object({
      runnerRef: z.literal(`github:vibelingan/channel:${match[1]}:attempt-${match[2]}`),
      checkedAt: counter,
      job: z
        .object({ status: z.literal('completed'), evidenceRef: z.string().min(1) })
        .passthrough(),
      cloud: z
        .object({
          status: z.literal('quiescent'),
          kind: z.literal('stopped-site-html-batch'),
          operationId: z.literal(step.operationId),
          observedHash: z.literal(step.afterHash),
          evidenceRef: z.string().min(1),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(run.reconciliation);
  if (
    !proof.success ||
    proof.data.checkedAt > now() ||
    !new RegExp(
      `^github:${match[1]}:attempt-${match[2]}:job-[1-9][0-9]*:(success|failure|cancelled|timed_out):source-${run.composition.static.codeSha}$`,
    ).test(proof.data.job.evidenceRef) ||
    proof.data.cloud.evidenceRef !==
      `candidate:${run.composition.static.artifact.artifactId}:batch:${step.afterHash}:three-cache-modes:absent:seo-catalog-region-${match[1]}-${match[2]}`
  )
    return reject();
  const beginRow = await store.get(
    'catalogSeoBuilders',
    catalogRegionalReceiptId(run.runId, input.beginRequestId),
  );
  const endRow = await store.get(
    'catalogSeoBuilders',
    catalogRegionalReceiptId(run.runId, input.endRequestId),
  );
  if (
    !beginRow ||
    !endRow ||
    beginRow.action !== 'delivery.begin' ||
    endRow.action !== 'delivery.end'
  )
    return reject();
  const parsedBegin = z
    .object({ ticket: ticketSchema, expectedHeads: z.array(CatalogPublicHeadSchema).max(12) })
    .strict()
    .safeParse(beginRow.result);
  if (!parsedBegin.success) return reject();
  const ticket = parsedBegin.data.ticket;
  const products = step.members.map((member) =>
    member.path.slice('products/p-'.length, -'/index.html'.length),
  );
  if (
    !ticket.owner.startsWith(`${run.runId}:`) ||
    ticket.owner.length <= run.runId.length + 1 ||
    new Set(ticket.products).size !== ticket.products.length ||
    !isDeepStrictEqual([...products].sort(), [...ticket.products].sort()) ||
    parsedBegin.data.expectedHeads.some(
      (head) => head.siteOrigin !== config.siteOrigin || !ticket.products.includes(head.productId),
    ) ||
    new Set(parsedBegin.data.expectedHeads.map((head) => head.productId)).size !==
      parsedBegin.data.expectedHeads.length
  )
    return reject();
  const oldBase = {
    ...request,
    runId: run.runId,
    executorCodeSha: run.composition.static.codeSha,
    guard: {
      targetId: config.targetId,
      ownerRunId: run.ownerRunId,
      fence: run.fence,
      acquiredVersion: run.acquiredVersion,
    },
  };
  const begin = {
    ...oldBase,
    requestId: input.beginRequestId,
    action: 'delivery.begin',
    input: { expectedWrites: input.originalWrites, products: ticket.products, discovery: false },
  };
  const end = {
    ...oldBase,
    requestId: input.endRequestId,
    action: 'delivery.end',
    input: { expectedWrites: input.originalWrites, ticket, outcome: 'unknown' },
  };
  readReceipt(beginRow, run.runId, input.beginRequestId, catalogRegionalRequestHash(begin));
  const ended = readReceipt(endRow, run.runId, input.endRequestId, catalogRegionalRequestHash(end));
  if (
    !isDeepStrictEqual(ended, { ended: true }) ||
    Date.parse(String(endRow.completedAt)) < Date.parse(String(beginRow.completedAt))
  )
    reject();
  await assertCurrentLease(store, request, config, now());
  return { ticket };
}
async function assertRecoveryReceiptCurrent(
  store: Pick<CatalogSeoStore, 'get'>,
  row: CollectionDoc,
  request: CatalogRegionalRequest,
  config: CatalogRegionalConfig,
  now: () => number,
) {
  const original: RecoveryClearRequest = {
    ...request,
    action: 'recovery.clear',
    input: recoveryInputSchema.parse(row.recoveryInput),
  };
  const source = await assertFailedRecoverySource(store, original, config, now);
  const control = readCatalogSeoControl(
    await store.get('catalogSeoControl', catalogSeoControlId(config.siteOrigin)),
    config.siteOrigin,
    new Date(now()).toISOString(),
  );
  assertRecoveryControl(control, source.ticket, original.input.originalWrites, now());
  await assertCurrentLease(store, request, config, now());
}

async function clearRegistrationStep(
  store: CatalogSeoStore,
  request: RegistrationClearRequest | RecoveryClearRequest,
  config: CatalogRegionalConfig,
  clock: () => string,
  now: () => number,
): Promise<JsonResult> {
  const recovery =
    request.action === 'recovery.clear'
      ? await assertFailedRecoverySource(store, request, config, now)
      : null;
  if (request.action === 'registration.clear')
    await assertAcceptedRegistration(store, request, config, now());
  if (request.action === 'recovery.clear')
    assertRecoveryProgress(
      await store.get('catalogSeoBuilders', recoveryProgressId(request)),
      request,
    );
  const sourceRunId =
    request.action === 'recovery.clear' ? request.input.stoppedRunId : config.runId;
  const controlId = catalogSeoControlId(config.siteOrigin);
  const owned = async (reader: Pick<CatalogSeoStore, 'get'>) => {
    const control = readCatalogSeoControl(
      await reader.get('catalogSeoControl', controlId),
      config.siteOrigin,
      clock(),
    );
    if (request.action === 'recovery.clear' && recovery) {
      assertRecoveryControl(control, recovery.ticket, request.input.originalWrites, now());
      return control;
    }
    if (
      control.state !== 'idle' &&
      (!control.owner?.startsWith(`${config.runId}:`) || control.discovery)
    )
      throw new RegionalError('REGIONAL_REGISTRATION_OWNER_CHANGED');
    for (const productId of control.products) {
      const id = catalogPublicRecordId(config.siteOrigin, productId);
      const head = CatalogPublicHeadSchema.parse(await reader.get('catalogPublicHeads', id));
      if (head._id !== id || head.siteOrigin !== config.siteOrigin || head.productId !== productId)
        throw new RegionalError('REGIONAL_REGISTRATION_OWNER_CHANGED');
    }
    return control;
  };
  await owned(store);
  const { state, cursor } = request.input;
  const selected: ReturnType<typeof CatalogSeoTaskSchema.parse>[] = [];
  let next: { state: (typeof cleanupStates)[number]; cursor: string | null } | null = null;
  if (state !== 'control') {
    const rows = await store.list(
      'catalogSeoTasks',
      { siteOrigin: config.siteOrigin, state },
      cursor,
      100,
    );
    if (rows.length > 100) throw new RegionalError('REGIONAL_RESULT_LIMIT');
    let last = cursor;
    let remaining = false;
    for (const row of rows) {
      const task = CatalogSeoTaskSchema.parse(row);
      if (
        task.siteOrigin !== config.siteOrigin ||
        task.state !== state ||
        task._id !== catalogPublicRecordId(config.siteOrigin, task.productId) ||
        task._id <= (last ?? '')
      )
        throw new RegionalError('REGIONAL_REGISTRATION_TASK_CHANGED');
      if (task.lease?.runId === sourceRunId) {
        if (selected.length === 2) {
          remaining = true;
          break;
        }
        selected.push(task);
      }
      last = task._id;
    }
    if (remaining || rows.length === 100) {
      if (!last || last === cursor) throw new RegionalError('REGIONAL_RESULT_LIMIT');
      next = { state, cursor: last };
    } else {
      const index = cleanupStates.indexOf(state);
      const nextState = cleanupStates[index + 1];
      if (!nextState) throw new RegionalError('REGIONAL_RESULT_LIMIT');
      next = { state: nextState, cursor: null };
    }
  }
  return store.transaction(async (tx) => {
    if (request.action === 'recovery.clear') {
      const current = await assertFailedRecoverySource(tx, request, config, now);
      if (!recovery || !isDeepStrictEqual(current.ticket, recovery.ticket))
        throw new RegionalError('REGIONAL_RECOVERY_SOURCE_CHANGED');
      assertRecoveryProgress(
        await tx.get('catalogSeoBuilders', recoveryProgressId(request)),
        request,
      );
    } else await assertAcceptedRegistration(tx, request, config, now());
    const control = await owned(tx);
    const release = [];
    for (const expected of selected) {
      const task = CatalogSeoTaskSchema.parse(await tx.get('catalogSeoTasks', expected._id));
      if (
        task._id !== expected._id ||
        task.siteOrigin !== config.siteOrigin ||
        task.productId !== expected.productId
      )
        throw new RegionalError('REGIONAL_REGISTRATION_TASK_CHANGED');
      if (task.lease?.runId === sourceRunId)
        release.push(CatalogSeoTaskSchema.parse({ ...task, state: 'pending', lease: null }));
    }
    const controlReleased = state === 'control' && control.state !== 'idle';
    if (controlReleased) {
      if (!Number.isSafeInteger(control.fence + 1))
        throw new RegionalError('REGIONAL_RESULT_LIMIT');
      await tx.set('catalogSeoControl', {
        ...idleCatalogSeoControl(config.siteOrigin, clock()),
        writes: control.writes,
        fence: control.fence + 1,
      });
    }
    for (const task of release) await tx.set('catalogSeoTasks', task);
    if (request.action === 'recovery.clear')
      await tx.set('catalogSeoBuilders', {
        _id: recoveryProgressId(request),
        schemaVersion: 1,
        purpose: 'catalog-failed-recovery-progress',
        next: state === 'control' ? null : next,
      });
    return { done: state === 'control', next, releasedTasks: release.length, controlReleased };
  });
}
function deliveryResult(request: CatalogRegionalRequest, value: unknown): JsonResult {
  if (
    ['registration.clear', 'registration.activate', 'recovery.clear'].includes(request.action) &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    return { ...value };
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
    ...(request.action === 'registration.activate' ? { activationInput: request.input } : {}),
    ...(request.action === 'recovery.clear' ? { recoveryInput: request.input } : {}),
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
  now: () => number,
): Promise<JsonResult> {
  const completed = await store.get(
    'catalogSeoBuilders',
    catalogRegionalReceiptId(config.runId, requestId),
  );
  if (completed) {
    const result = readReceipt(completed, config.runId, requestId, inputHash);
    if (completed.action === 'delivery.begin') {
      await assertCurrentLease(store, request, config, now());
      await assertBeginStillOwned(store, config.siteOrigin, result);
    }
    if (completed.action === 'registration.activate')
      await assertActivationReceiptCurrent(store, completed, request, config, now);
    if (completed.action === 'recovery.clear')
      await assertRecoveryReceiptCurrent(store, completed, request, config, now);
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
