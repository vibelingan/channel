import { manageCatalogPreparationJob, readCatalogPreparationLease } from '@vibelingan-channel/db';
import type { CatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { readCatalogPreparationCandidate } from './catalog-preparation-inspect.ts';

/** Backend only. Product scope comes from a current lease, never a caller-supplied product ID. */
export async function inspectCatalogPreparationJob(
  authority: CatalogPreparationAuthority,
  jobId: string,
  lease: unknown,
  options: { now?: () => number; budgetMs?: number; mediaMode?: 'metadata' | 'defer' } = {},
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
  // Settle changed input through the fenced transition before returning the conflict.
  const settleConflict = async () => {
    try {
      await renew();
    } catch {
      return { ok: false as const, code: 'UNAVAILABLE' as const };
    }
    return { ok: false as const, code: 'CONFLICT' as const };
  };
  const now = options.now ?? Date.now;
  const binding: {
    scope?: NonNullable<ReturnType<CatalogPreparationAuthority['currentLeaseScope']>>;
  } = {};
  const candidate = await readCatalogPreparationCandidate(
    { productId: initial.progress.productId },
    async () => {
      const scope = await readCatalogPreparationLease(authority, jobId, lease, now());
      if (!scope || scope.jobId !== jobId || scope.productId !== initial.progress.productId)
        return { ok: false as const, code: 'CONFLICT' as const };
      binding.scope ??= scope;
      return { ok: true as const };
    },
    options,
  );
  if (!candidate.ok) return candidate.code === 'CONFLICT' ? settleConflict() : candidate;
  const scope = binding.scope;
  if (
    !scope ||
    candidate.productId !== scope.productId ||
    candidate.inputDigest !== scope.inputDigest ||
    candidate.contentGeneration !== scope.contentGeneration
  )
    return settleConflict();
  return candidate;
}
