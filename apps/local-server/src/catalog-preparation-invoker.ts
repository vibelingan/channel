import {
  CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
  type CatalogPreparationInvoker,
  withCatalogPreparationDeadline,
} from '../../functions/admin/src/catalog-preparation-invoker.ts';

/** Local execution can finish in the long-lived server after an unknown invocation result. */
export function createLocalCatalogPreparationInvoker(
  execute: CatalogPreparationInvoker,
  timeoutMs = CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
): CatalogPreparationInvoker {
  return withCatalogPreparationDeadline(
    async (call) => ({ result: await execute(call) }),
    timeoutMs,
  );
}
