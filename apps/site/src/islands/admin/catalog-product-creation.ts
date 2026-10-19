import { apiUrl } from '../../lib/api-url.ts';
import { getToken, getUser } from '../../lib/session.ts';
import { AdminApiError, DraftSavedError, createRecord } from './api.ts';
import {
  CreatedProductChangedError,
  type ProductCreationAttempt,
  type ProductCreationScope,
  captureProductCreation,
  checkProductCreation,
} from './catalog-product-create-api.ts';
import {
  type PublicationJournalStorage,
  createPublicationJournal,
} from './catalog-publication-journal.ts';

type CreationSession = { actorId: string; token: string; endpoint: string };
function currentSession(): CreationSession | null {
  try {
    const token = getToken();
    const actorId = getUser()?.id;
    return token && actorId
      ? { actorId, token, endpoint: new URL(apiUrl('/api/admin'), globalThis.location?.href).href }
      : null;
  } catch {
    return null;
  }
}

/** One form owns its captured input. A reopened form can query the same private receipt. */
export function createProductCreationController(
  options: {
    storage?: () => PublicationJournalStorage;
    session?: () => CreationSession | null;
  } = {},
) {
  const session = options.session ?? currentSession;
  const initial = session();
  if (!initial?.token)
    throw new AdminApiError('UNAUTHORIZED', 'Sign in before creating a product.');
  const bound = { ...initial };
  const owner = { actorId: bound.actorId, endpoint: bound.endpoint };
  const journal = createPublicationJournal(owner, options.storage, 'creation');
  let active: ProductCreationAttempt | undefined;
  let running = false;
  const assertCurrent = () => {
    const current = session();
    if (
      !current ||
      current.actorId !== bound.actorId ||
      current.token !== bound.token ||
      current.endpoint !== bound.endpoint
    )
      throw new AdminApiError(
        'UNAUTHORIZED',
        'Return to the original account and environment to check this creation.',
      );
  };
  const scope = (attempt: ProductCreationScope) => ({
    scope: {
      productId: 'new-product',
      operationId: attempt.attemptId,
      inputDigest: attempt.inputDigest,
    },
  });
  const pending = () => {
    assertCurrent();
    const snapshot = journal.read();
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry) => {
        if (!entry.scope.inputDigest)
          throw new AdminApiError(
            'RECOVERY_CORRUPT',
            'The saved creation is missing its input binding.',
          );
        return { attemptId: entry.scope.operationId, inputDigest: entry.scope.inputDigest };
      }),
    };
  };
  const forget = (selected: ProductCreationScope) => {
    assertCurrent();
    journal.forget(scope(selected).scope);
  };
  return {
    pending,
    export: () => journal.export(),
    async check(selected: ProductCreationScope) {
      if (running) throw new AdminApiError('BUSY', 'This creation is already being checked.');
      running = true;
      try {
        assertCurrent();
        const result = await checkProductCreation(selected, undefined, assertCurrent);
        forget(selected);
        if (active?.attemptId === selected.attemptId) active = undefined;
        return result.product;
      } finally {
        running = false;
      }
    },
    async save(values: Record<string, unknown>) {
      if (running) throw new AdminApiError('BUSY', 'This product is already being saved.');
      running = true;
      let fresh = false;
      try {
        assertCurrent();
        const captured = await captureProductCreation({ ...values, published: false });
        assertCurrent();
        const saved = pending();
        if (saved.problems.includes('corrupt') || saved.problems.includes('limit'))
          throw new AdminApiError(
            'RECOVERY_CORRUPT',
            'Check the saved creation record before starting another product.',
          );
        if (active && active.inputDigest !== captured.inputDigest)
          throw new AdminApiError(
            'CREATION_PENDING',
            'Check the original creation first. Your current edits have been kept.',
          );
        if (!active && saved.entries.length) {
          const selected = saved.entries.length === 1 ? saved.entries[0] : undefined;
          if (!selected || selected.inputDigest !== captured.inputDigest)
            throw new AdminApiError(
              'CREATION_PENDING',
              'Check the earlier creation before starting another product.',
            );
          active = { ...captured, ...selected };
        }
        fresh = !active;
        active ??= captured;
        if (journal.retain(scope(active)).durability !== 'persistent')
          throw new AdminApiError(
            'STORAGE_UNAVAILABLE',
            'Allow browser storage before creating this product. No new request was sent.',
          );
        const selected = active;
        if (!fresh) {
          try {
            const result = await checkProductCreation(
              { attemptId: selected.attemptId, inputDigest: selected.inputDigest },
              undefined,
              assertCurrent,
            );
            if (values.published === true) throw new CreatedProductChangedError(result.product);
            forget(active);
            active = undefined;
            return result.product;
          } catch (error) {
            if (!(error instanceof AdminApiError) || error.code !== 'NOT_FOUND') throw error;
          }
        }
        const result = await createRecord('products', values, selected, assertCurrent);
        forget(selected);
        active = undefined;
        return result;
      } catch (error) {
        if (
          active &&
          (error instanceof DraftSavedError ||
            error instanceof CreatedProductChangedError ||
            (fresh &&
              error instanceof AdminApiError &&
              [
                'BAD_REQUEST',
                'VALIDATION_ERROR',
                'CONFLICT',
                'INVALID_PRODUCT',
                'INVALID_IDENTITY',
              ].includes(error.code)))
        ) {
          forget(active);
          active = undefined;
        }
        throw error;
      } finally {
        running = false;
      }
    },
  };
}
