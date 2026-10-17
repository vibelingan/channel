import { manageCatalogPreparationJob } from '@vibelingan-channel/db';
import type {
  CatalogPreparationAuthority,
  CatalogPreparationJobProgress,
  CatalogPreparationJobResult,
  CatalogPreparationJobStatus,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { z } from 'zod';
import {
  type CatalogPreparationContinuationResult,
  continueHumanCatalogPreparation,
} from './catalog-preparation-continue.ts';
import type { CatalogPreparationInvoker } from './catalog-preparation-invoker.ts';
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const jobId = z.string().regex(/^[a-f0-9]{64}$/);
const expectedLeaseVersion = z.number().int().nonnegative().safe();
const humanCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), productId: id }).strict(),
  z.object({ action: z.literal('status'), jobId }).strict(),
  z.object({ action: z.literal('continue'), jobId }).strict(),
  z.object({ action: z.literal('cancel'), jobId, expectedLeaseVersion }).strict(),
  z.object({ action: z.literal('retry'), jobId, expectedLeaseVersion }).strict(),
]);
type HumanResult =
  | CatalogPreparationContinuationResult
  | Extract<CatalogPreparationJobResult, { ok: false }>
  | { ok: true; progress: CatalogPreparationJobProgress }
  | { ok: true; status: CatalogPreparationJobStatus; recovery?: 'status' };
/** The session actor is supplied by the handler; browser input has no technical capability. */
export async function manageHumanCatalogPreparation(
  authority: CatalogPreparationAuthority,
  actorId: string,
  input: unknown,
  invoke?: CatalogPreparationInvoker,
): Promise<HumanResult> {
  const parsed = humanCommand.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  if (parsed.data.action === 'continue')
    return invoke
      ? continueHumanCatalogPreparation(authority, actorId, parsed.data.jobId, invoke)
      : { ok: false, code: 'FORBIDDEN' };
  const command = { ...parsed.data, actorId };
  let result: CatalogPreparationJobResult;
  try {
    result = await manageCatalogPreparationJob(authority, command);
  } catch {
    console.warn('[catalog-preparation] confirming unacknowledged human operation', {
      action: command.action,
      ...(command.action === 'start' ? { productId: command.productId } : { jobId: command.jobId }),
    });
    if (command.action === 'start' || command.action === 'status') {
      result = await manageCatalogPreparationJob(authority, command);
    } else {
      const observed = await manageCatalogPreparationJob(authority, {
        action: 'status',
        actorId,
        jobId: command.jobId,
      });
      if (!observed.ok) return { ok: false, code: observed.code };
      return 'status' in observed
        ? { ok: true, status: observed.status, recovery: 'status' }
        : { ok: false, code: 'CORRUPT' };
    }
  }
  if (!result.ok) return { ok: false, code: result.code };
  if ('status' in result) return { ok: true, status: result.status };
  if ('progress' in result) return { ok: true, progress: result.progress };
  return { ok: false, code: 'CORRUPT' };
}
