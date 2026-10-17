import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import type { cloudStorageSdk } from '@vibelingan-channel/db/cloudbase';

export const CATALOG_PREPARATION_INVOKE_TIMEOUT_MS = 8000;
export type CatalogPreparationInvoker = (
  call: ReturnType<CatalogPreparationAuthority['issueCall']>,
) => Promise<unknown>;

/** An expired wait has an unknown outcome. Both late settlements remain handled. */
export function withCatalogPreparationDeadline(
  invoke: CatalogPreparationInvoker,
  timeoutMs = CATALOG_PREPARATION_INVOKE_TIMEOUT_MS,
): CatalogPreparationInvoker {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > CATALOG_PREPARATION_INVOKE_TIMEOUT_MS
  )
    throw Error('Invalid preparation invocation deadline');
  return (call) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Object.assign(Error('Preparation result unconfirmed'), {
              code: 'PREPARATION_RESULT_TIMEOUT',
            }),
          ),
        timeoutMs,
      );
      Promise.resolve()
        .then(() => invoke(call))
        .then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
}
/** The initialized SDK binds the environment; the browser cannot select a function or retry policy. */
export function createCatalogPreparationInvoker(
  sdk: Pick<ReturnType<typeof cloudStorageSdk>, 'callFunction'>,
  options: { timeoutMs?: number } = {},
): CatalogPreparationInvoker {
  const timeoutMs = options.timeoutMs ?? CATALOG_PREPARATION_INVOKE_TIMEOUT_MS;
  return withCatalogPreparationDeadline(
    (call) =>
      sdk.callFunction(
        { name: 'alibaba-catalog-sync', qualifier: '$LATEST', data: call },
        { timeout: timeoutMs, retryOptions: { retries: 0 } },
      ),
    timeoutMs,
  );
}
