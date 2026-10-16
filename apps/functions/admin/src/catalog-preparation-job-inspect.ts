import { manageCatalogPreparationJob } from '@vibelingan-channel/db';
import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { readCatalogPreparationCandidate } from './catalog-preparation-inspect.ts';

/** Backend only. Product scope comes from a current lease, never a caller-supplied product ID. */
export async function inspectCatalogPreparationJob(
  authority: CatalogPreparationAuthority,
  jobId: string,
  lease: unknown,
  options: { now?: () => number; budgetMs?: number } = {},
) {
  const renew = () =>
    manageCatalogPreparationJob(authority, { action: 'renew', jobId, lease }, options.now?.());
  const initial = await renew();
  if (!initial.ok) return { ok: false as const, code: initial.code };
  if (
    !('progress' in initial) ||
    initial.progress.jobId !== jobId ||
    initial.progress.state !== 'running'
  )
    return { ok: false as const, code: 'CONFLICT' as const };
  return readCatalogPreparationCandidate(
    { productId: initial.progress.productId },
    async () => {
      const current = await renew();
      return current.ok &&
        'progress' in current &&
        current.progress.jobId === jobId &&
        current.progress.productId === initial.progress.productId &&
        current.progress.state === 'running'
        ? { ok: true as const }
        : { ok: false as const, code: 'CONFLICT' as const };
    },
    options,
  );
}
