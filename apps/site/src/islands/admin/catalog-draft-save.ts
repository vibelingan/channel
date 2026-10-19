import type { CollectionDoc } from '@vibelingan-channel/shared';
import { fitsJsonBudget } from '@vibelingan-channel/shared/admin-product-list';
import {
  CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES,
  type CatalogProductOperationStatus,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { z } from 'zod';
import { AdminApiError, catalogProductOperationCall, getRecord } from './api.ts';
import { type PublicationScope, PublicationScopeSchema } from './catalog-product-operation-api.ts';
import {
  type PublicationBatchOptions,
  createPublicationBatch,
} from './catalog-publication-batch.ts';
import { createPublicationJournal } from './catalog-publication-journal.ts';

const startSchema = z
  .object({
    action: z.literal('product-operation-start'),
    intent: z.literal('save-draft'),
    productId: PublicationScopeSchema.shape.productId,
    operationId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime().nullable(),
    values: z.record(z.unknown()),
  })
  .strict();
type Start = z.infer<typeof startSchema>;
type Command =
  | Start
  | {
      action: 'product-operation-get' | 'product-operation-save' | 'product-operation-cancel';
      productId: string;
      operationId: string;
      inputDigest?: string;
    }
  | {
      action: 'product-operation-stop';
      intent: 'save-draft';
      productId: string;
      operationId: string;
    };
export type DraftSaveResult = {
  state: 'saved' | 'historical' | 'cancelled' | 'reserved';
  scope: PublicationScope;
  status: CatalogProductOperationStatus;
  product?: CollectionDoc;
};
type Options = Pick<
  PublicationBatchOptions,
  'session' | 'storage' | 'authorize' | 'readProduct'
> & {
  request?: (input: unknown) => Promise<unknown>;
};
const definite = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'SOURCE_NOT_READY',
  'MEDIA_NOT_READY',
  'MEDIA_BUSY',
  'BUSY',
  'APPROVAL_EXPIRED',
  'APPROVAL_TOO_LARGE',
]);
const failure = (code: string, message: string) => new AdminApiError(code, message);
const missing = (error: unknown) => error instanceof AdminApiError && error.code === 'NOT_FOUND';

/** A private edit stays in this form. Persistent recovery contains only its original identifiers. */
export function createDraftSaveController(productId: string, options: Options = {}) {
  PublicationScopeSchema.shape.productId.parse(productId);
  const session = createPublicationBatch(options);
  const journal = createPublicationJournal(session.owner, options.storage, 'draft');
  const request = options.request ?? catalogProductOperationCall;
  const terminal = new Set<string>();
  let active: Start | undefined;
  let running = false;
  const pending = () => {
    session.assertCurrent();
    const result = journal.read();
    return {
      ...result,
      entries: result.entries.filter((entry) => entry.scope.productId === productId),
    };
  };
  const retain = (scope: PublicationScope) => {
    session.assertCurrent();
    return journal.retain({ scope });
  };
  const selected = (input: PublicationScope) => {
    const scope = PublicationScopeSchema.parse(input);
    const saved = pending().entries.find((entry) => entry.scope.operationId === scope.operationId);
    if (
      !saved ||
      scope.productId !== productId ||
      (scope.inputDigest && saved.scope.inputDigest !== scope.inputDigest)
    )
      throw failure('RECOVERY_MISSING', 'Choose the original save for this product.');
    return saved.scope;
  };
  const query = (scope: PublicationScope): Command => ({
    action: 'product-operation-get',
    productId,
    operationId: scope.operationId,
  });
  const read = (value: unknown, scope: PublicationScope) => {
    const result = CatalogProductOperationStatusSchema.safeParse(value);
    if (
      !result.success ||
      result.data.productId !== productId ||
      result.data.operationId !== scope.operationId ||
      result.data.intent !== 'save-draft' ||
      !['reserved', 'saved'].includes(result.data.state) ||
      (scope.inputDigest !== undefined && result.data.inputDigest !== scope.inputDigest)
    )
      throw failure(
        'INVALID_RESPONSE',
        'The reply did not confirm this original save. Check it again.',
      );
    return result.data;
  };
  const invoke = async (command: Command, scope: PublicationScope) => {
    session.assertCurrent();
    try {
      const response = await request(command);
      session.assertCurrent();
      return read(response, scope);
    } catch (error) {
      session.assertCurrent();
      if (
        command.action === 'product-operation-get' ||
        (error instanceof AdminApiError && definite.has(error.code))
      )
        throw error;
      try {
        const response = await request(query(scope));
        session.assertCurrent();
        return read(response, scope);
      } catch (confirmation) {
        session.assertCurrent();
        if (
          confirmation instanceof AdminApiError &&
          ['UNAUTHORIZED', 'FORBIDDEN'].includes(confirmation.code)
        )
          throw confirmation;
        const unknown = failure(
          'SAVE_UNCONFIRMED',
          'This save could not be confirmed. Check the original save before trying again.',
        );
        unknown.cause = new AggregateError(
          [error, confirmation],
          'Save response and confirmation failed',
        );
        throw unknown;
      }
    }
  };
  const finish = async (status: CatalogProductOperationStatus): Promise<DraftSaveResult> => {
    const scope = { productId, operationId: status.operationId, inputDigest: status.inputDigest };
    retain(scope);
    if (status.state === 'saved') {
      session.assertCurrent();
      const product = await (options.readProduct
        ? options.readProduct(productId, AbortSignal.timeout(8000))
        : getRecord('products', productId, AbortSignal.timeout(8000)));
      session.assertCurrent();
      if (product._id !== productId)
        throw failure('INVALID_RESPONSE', 'The saved product could not be checked.');
      const state =
        status.current &&
        status.revisionCurrent &&
        product.updatedAt === status.saved.productUpdatedAt &&
        product.published !== true &&
        product.archived !== true
          ? 'saved'
          : 'historical';
      terminal.add(status.operationId);
      return { state, scope, status, product };
    }
    if ('cancelledAt' in status && status.cancelledAt !== undefined) {
      terminal.add(status.operationId);
      return { state: 'cancelled', scope, status };
    }
    return { state: 'reserved', scope, status };
  };
  const advance = async (status: CatalogProductOperationStatus) => {
    if (status.state !== 'reserved' || status.cancelledAt !== undefined) return finish(status);
    const scope = { productId, operationId: status.operationId, inputDigest: status.inputDigest };
    retain(scope);
    if (!status.current || !status.revisionCurrent || status.expired)
      throw failure(
        'CONFLICT',
        'This draft changed. Stop this save and open the current product. Your form edits have been kept.',
      );
    await session.verifySession();
    return finish(await invoke({ action: 'product-operation-save', ...scope }, scope));
  };
  const exclusive = async <T>(work: () => Promise<T>) => {
    if (running) throw failure('BUSY', 'This original save is already being checked.');
    running = true;
    try {
      session.assertCurrent();
      return await work();
    } finally {
      running = false;
    }
  };
  return {
    pending,
    export: () => {
      session.assertCurrent();
      return journal.export();
    },
    acknowledge(input: PublicationScope) {
      if (running) throw failure('BUSY', 'Wait for this original save to finish checking.');
      const scope = selected(input);
      if (!terminal.has(scope.operationId))
        throw failure(
          'SAVE_UNCONFIRMED',
          'Check the original save before closing its recovery record.',
        );
      const result = journal.forget(scope);
      if (
        !result.entries.some(
          (entry) =>
            entry.scope.productId === productId && entry.scope.operationId === scope.operationId,
        )
      ) {
        terminal.delete(scope.operationId);
        if (active?.operationId === scope.operationId) active = undefined;
      }
      return {
        ...result,
        entries: result.entries.filter((entry) => entry.scope.productId === productId),
      };
    },
    save(opened: CollectionDoc, input: Record<string, unknown>) {
      // Capture before authorization or any other await; later form edits never alter this attempt.
      let captured: Start;
      try {
        if (
          opened._id !== productId ||
          opened.published === true ||
          opened.archived === true ||
          input.published === true
        )
          throw failure('BAD_REQUEST', 'Use draft save only for an unpublished product.');
        const { published: _published, ...values } = input;
        const raw = {
          action: 'product-operation-start',
          intent: 'save-draft',
          productId,
          operationId: crypto.randomUUID(),
          expectedUpdatedAt: opened.updatedAt ?? null,
          values,
        };
        if (!fitsJsonBudget(raw, CATALOG_PRODUCT_OPERATION_INPUT_MAX_BYTES, 24))
          throw failure('VALIDATION_ERROR', 'The product draft is too large.');
        captured = startSchema.parse(JSON.parse(JSON.stringify(raw)));
      } catch (error) {
        return Promise.reject(error);
      }
      return exclusive(async () => {
        const before = pending();
        if (active || before.entries.length)
          throw failure(
            'SAVE_PENDING',
            'Check or stop the original save first. Your current form edits have been kept.',
          );
        if (before.problems.length)
          throw failure(
            'RECOVERY_CORRUPT',
            'Check browser recovery storage before saving this draft.',
          );
        await session.verifySession();
        active = captured;
        const scope = { productId, operationId: captured.operationId };
        if (retain(scope).durability !== 'persistent')
          throw failure(
            'STORAGE_UNAVAILABLE',
            'Allow browser storage before saving. No save request was sent.',
          );
        return advance(await invoke(captured, scope));
      });
    },
    check(input: PublicationScope) {
      return exclusive(async () => {
        const scope = selected(input);
        return finish(await invoke(query(scope), scope));
      });
    },
    resume(input: PublicationScope) {
      return exclusive(async () => {
        const scope = selected(input);
        let status: CatalogProductOperationStatus;
        try {
          status = await invoke(query(scope), scope);
        } catch (error) {
          if (!missing(error) || scope.inputDigest !== undefined) throw error;
          if (!active || active.operationId !== scope.operationId)
            throw failure(
              'SAVE_INPUT_MISSING',
              'This form no longer has the original save input. Stop this save before starting another.',
            );
          await session.verifySession();
          status = await invoke(active, scope);
        }
        return advance(status);
      });
    },
    stop(input: PublicationScope) {
      return exclusive(async () => {
        const scope = selected(input);
        let status: CatalogProductOperationStatus;
        try {
          status = await invoke(query(scope), scope);
        } catch (error) {
          if (!missing(error) || scope.inputDigest !== undefined) throw error;
          await session.verifySession();
          status = await invoke(
            {
              action: 'product-operation-stop',
              intent: 'save-draft',
              productId,
              operationId: scope.operationId,
            },
            scope,
          );
        }
        if (status.state === 'saved') return finish(status);
        const bound = {
          productId,
          operationId: status.operationId,
          inputDigest: status.inputDigest,
        };
        retain(bound);
        if (!('cancelledAt' in status) || status.cancelledAt === undefined) {
          await session.verifySession();
          status = await invoke({ action: 'product-operation-cancel', ...bound }, bound);
        }
        if (
          status.state !== 'saved' &&
          (!('cancelledAt' in status) || status.cancelledAt === undefined)
        )
          throw failure(
            'SAVE_UNCONFIRMED',
            'The original save did not confirm its stop. Check it again.',
          );
        return finish(await invoke(query(bound), bound));
      });
    },
  };
}
