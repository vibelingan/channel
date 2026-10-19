import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import { apiUrl } from '../../lib/api-url.ts';
import { getToken, getUser } from '../../lib/session.ts';
import { AdminApiError, catalogProductOperationCall, fetchCurrentUser } from './api.ts';
import { managePreparation } from './catalog-preparation-api.ts';
import {
  type PublicationAttempt,
  type PublicationCheckpoint,
  PublicationCheckpointSchema,
  capturePublicationCommand,
} from './catalog-product-operation-api.ts';
import { type PublicationCheckResult, checkPublication } from './catalog-publication-check.ts';
import {
  type PublicationJournalStorage,
  createPublicationJournal,
} from './catalog-publication-journal.ts';
import {
  type PublicationRunOptions,
  type PublicationRunResult,
  runPublication,
} from './catalog-publication-run.ts';

export type BatchEntry = PublicationAttempt | PublicationCheckpoint;
export type BatchSession = { actorId: string; token: string; endpoint: string };
type Failure = { code: string; message: string };
type ItemBase = {
  scope: PublicationCheckpoint['scope'];
  run?: PublicationRunResult;
  error?: Failure;
};
export type PublicationBatchItem = ItemBase &
  (
    | { state: 'confirmed'; check: Extract<PublicationCheckResult, { reason: 'confirmed' }> }
    | {
        state: 'not-started' | 'needs-action' | 'paused' | 'unknown' | 'historical' | 'cancelled';
        check?: PublicationCheckResult;
      }
  );
export type PublicationBatchOptions = {
  session?: () => BatchSession | null;
  authorize?: (signal: AbortSignal) => Promise<{ id: string; role: string }>;
  storage?: () => PublicationJournalStorage;
  request?: PublicationRunOptions['request'];
  preparationRequest?: PublicationRunOptions['preparationRequest'];
  fetch?: typeof globalThis.fetch;
  run?: typeof runPublication;
  check?: typeof checkPublication;
  onItem?: (item: PublicationBatchItem) => void | Promise<void>;
};
let active = 0;
const waiting: Array<() => void> = [];
const products = new Set<string>();
function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let granted = false;
    const abort = () => {
      if (granted) return;
      const index = waiting.indexOf(enter);
      if (index >= 0) waiting.splice(index, 1);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const enter = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(signal.reason);
        waiting.shift()?.();
        return;
      }
      granted = true;
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting.shift()?.();
      });
    };
    if (active < 4) enter();
    else {
      waiting.push(enter);
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}
function currentSession(): BatchSession | null {
  try {
    const token = getToken();
    const actorId = getUser()?.id;
    return token && typeof actorId === 'string'
      ? { actorId, token, endpoint: new URL(apiUrl('/api/admin'), globalThis.location?.href).href }
      : null;
  } catch {
    return null;
  }
}
function capture(input: unknown): BatchEntry[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100)
    throw new AdminApiError('VALIDATION_ERROR', 'Select between 1 and 100 products.');
  const entries = Array.from(input, (value) => {
    if (value && typeof value === 'object' && 'action' in value) {
      const command = capturePublicationCommand(value);
      if (command.action === 'product-operation-start') return command;
    } else if (fitsJsonBudget(value, 4096, 12)) {
      const parsed = PublicationCheckpointSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    }
    throw new AdminApiError('VALIDATION_ERROR', 'Check the original publication selection.');
  });
  const ids = entries.map((entry) => ('action' in entry ? entry.productId : entry.scope.productId));
  if (new Set(ids).size !== ids.length)
    throw new AdminApiError('VALIDATION_ERROR', 'Each product must appear only once.');
  return entries;
}
function sameScope(
  value: PublicationCheckpoint['scope'],
  expected: PublicationCheckpoint['scope'],
) {
  return (
    value.productId === expected.productId &&
    value.operationId === expected.operationId &&
    (!expected.inputDigest || value.inputDigest === expected.inputDigest)
  );
}
function failure(error: unknown): Failure {
  return error instanceof AdminApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'UNAVAILABLE',
        message: 'This publication could not be checked. Keep its original task.',
      };
}
function until<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Share four complete publication flows, preserve original tasks, and count only public confirmations. */
export function createPublicationBatch(options: PublicationBatchOptions = {}) {
  const session = options.session ?? currentSession;
  const initial = session();
  if (!initial || !initial.token || typeof initial.token !== 'string')
    throw new AdminApiError('UNAUTHORIZED', 'Sign in before publishing products.');
  const bound = { ...initial };
  const owner = { actorId: bound.actorId, endpoint: bound.endpoint };
  const journal = createPublicationJournal(owner, options.storage);
  let running = false;
  return {
    owner: Object.freeze({ ...owner }),
    journal,
    async run(input: unknown, externalSignal?: AbortSignal) {
      const entries = capture(input);
      if (running) throw new AdminApiError('BUSY', 'This publication batch is already running.');
      running = true;
      const stop = new AbortController();
      const signal = externalSignal ? AbortSignal.any([externalSignal, stop.signal]) : stop.signal;
      let observerError: Failure | undefined;
      const guard = () => {
        signal.throwIfAborted();
        const live = session();
        if (
          !live ||
          live.actorId !== bound.actorId ||
          live.token !== bound.token ||
          live.endpoint !== bound.endpoint
        ) {
          const error = new AdminApiError(
            'UNAUTHORIZED',
            'Return to the original account and API environment to continue this batch.',
          );
          stop.abort(error);
          throw error;
        }
      };
      const privateCall = async <T>(send: () => Promise<T>): Promise<T> => {
        guard();
        try {
          const value = await send();
          guard();
          return value;
        } catch (error) {
          if (error instanceof AdminApiError && ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
            stop.abort(error);
          throw error;
        }
      };
      const request: NonNullable<PublicationBatchOptions['request']> = (command, rpcSignal) =>
        privateCall(() => (options.request ?? catalogProductOperationCall)(command, rpcSignal));
      const preparationRequest: NonNullable<PublicationBatchOptions['preparationRequest']> = (
        command,
        rpcSignal,
      ) => privateCall(() => (options.preparationRequest ?? managePreparation)(command, rpcSignal));
      const publicFetch: typeof globalThis.fetch = async (input, init) => {
        guard();
        const value = await (options.fetch ?? globalThis.fetch)(input, init);
        guard();
        return value;
      };
      const items: PublicationBatchItem[] = entries.map((entry) => ({
        state: 'not-started',
        scope: structuredClone(
          'action' in entry
            ? { productId: entry.productId, operationId: entry.operationId }
            : entry.scope,
        ),
      }));
      const notify = async (item: PublicationBatchItem) => {
        if (!options.onItem) return;
        try {
          guard();
          await until(
            Promise.resolve().then(() => options.onItem?.(structuredClone(item))),
            AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          );
        } catch (error) {
          observerError = failure(error);
          stop.abort(error);
        }
      };
      const one = async (index: number) => {
        const entry = entries[index];
        const before = items[index];
        if (!entry || !before) return;
        let release: (() => void) | undefined;
        let claimed = false;
        let entered = false;
        const key = JSON.stringify([owner.actorId, owner.endpoint, before.scope.productId]);
        let latest: PublicationCheckpoint =
          'action' in entry ? { scope: before.scope } : structuredClone(entry);
        try {
          guard();
          release = await acquire(signal);
          guard();
          if (products.has(key))
            throw new AdminApiError(
              'BUSY',
              'This product is already being published. Check its original task.',
            );
          products.add(key);
          claimed = true;
          const retain = (checkpoint: PublicationCheckpoint) => {
            guard();
            if (!sameScope(checkpoint.scope, latest.scope))
              throw new AdminApiError(
                'INVALID_RESPONSE',
                'Publication returned a different original task.',
              );
            latest = structuredClone(checkpoint);
            const saved = journal.retain(latest);
            if (saved.durability !== 'persistent') {
              const error = new AdminApiError(
                'RECOVERY_STORAGE_UNAVAILABLE',
                'Keep the recovery export and allow browser storage before continuing this publication.',
              );
              stop.abort(error);
              throw error;
            }
          };
          retain(latest);
          entered = true;
          const run = await (options.run ?? runPublication)(
            'action' in entry ? entry : entry.scope,
            {
              signal,
              request,
              preparationRequest,
              ...('referenceRecovery' in entry
                ? { referenceRecovery: entry.referenceRecovery }
                : {}),
              onStatus: async (_status, checkpoint) => retain(checkpoint),
            },
          );
          guard();
          if (!sameScope(run.scope, latest.scope))
            throw new AdminApiError(
              'INVALID_RESPONSE',
              'Publication returned a different original task.',
            );
          if (run.reason === 'committed') {
            if (!run.scope.inputDigest)
              throw new AdminApiError(
                'INVALID_RESPONSE',
                'Publication is missing its original input digest.',
              );
            const check = await (options.check ?? checkPublication)(run.scope, {
              signal,
              request,
              fetch: publicFetch,
            });
            guard();
            if (
              !sameScope(check.scope, run.scope) ||
              (check.reason === 'confirmed' &&
                (!sameScope(check.status, run.scope) ||
                  check.revision !== check.status.completion.revision))
            )
              throw new AdminApiError(
                'INVALID_RESPONSE',
                'The website confirmation belongs to a different original publication.',
              );
            items[index] =
              check.reason === 'confirmed'
                ? { state: 'confirmed', scope: check.scope, run, check }
                : {
                    state:
                      check.reason === 'historical'
                        ? 'historical'
                        : check.reason === 'paused'
                          ? 'paused'
                          : 'unknown',
                    scope: check.scope,
                    run,
                    check,
                    ...(check.error ? { error: check.error } : {}),
                  };
          } else
            items[index] = {
              state: run.reason,
              scope: run.scope,
              run,
              ...(run.error ? { error: run.error } : {}),
            };
          const item = items[index];
          if (item && ['confirmed', 'historical', 'cancelled'].includes(item.state))
            journal.forget(item.scope);
        } catch (error) {
          items[index] = {
            state: entered ? 'unknown' : 'not-started',
            scope: latest.scope,
            error: failure(error),
          };
        } finally {
          if (claimed) products.delete(key);
          release?.();
        }
        const item = items[index];
        if (item) await notify(item);
      };
      try {
        guard();
        const actor = await until(
          (options.authorize ?? (async () => (await fetchCurrentUser()).user))(signal),
          AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        );
        guard();
        if (actor.id !== owner.actorId || actor.role !== 'admin')
          throw new AdminApiError(
            'FORBIDDEN',
            'The original administrator account must be verified before publication.',
          );
        for (let offset = 0; offset < entries.length && !signal.aborted; offset += 20) {
          const end = Math.min(offset + 20, entries.length);
          let next = offset;
          const workers = await Promise.allSettled(
            Array.from({ length: Math.min(4, end - offset) }, async () => {
              while (next < end && !signal.aborted) {
                const index = next++;
                await one(index);
              }
            }),
          );
          const rejected = workers.find((worker) => worker.status === 'rejected');
          if (rejected?.status === 'rejected') {
            observerError = failure(rejected.reason);
            stop.abort(rejected.reason);
          }
        }
        return {
          owner: { ...owner },
          items,
          confirmed: items.filter((item) => item.state === 'confirmed').length,
          paused: signal.aborted,
          ...(observerError ? { observerError } : {}),
        };
      } finally {
        running = false;
      }
    },
  };
}
