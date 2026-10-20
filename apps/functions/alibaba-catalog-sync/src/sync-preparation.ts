import { z } from 'zod';
const count = z.number().int().nonnegative().safe();
export const SyncPreparationSchema = z
  .object({
    phase: z.enum(['drafts', 'photos', 'waiting', 'complete', 'attention']),
    cursor: z.string(),
    draftsCreated: count,
    photosCopied: count,
    photoIssues: count,
    retryBefore: z.string().datetime(),
    transportFailures: count,
    resumePhase: z.enum(['drafts', 'photos']),
    restartPass: z.boolean(),
    passWaiting: count,
    passBusy: count,
    retryAt: z.string().datetime().nullable(),
    failures: count,
  })
  .strict();
export type Preparation = z.infer<typeof SyncPreparationSchema>;
export const initialSyncPreparation = (at = new Date().toISOString()): Preparation => ({
  phase: 'photos',
  cursor: '',
  draftsCreated: 0,
  photosCopied: 0,
  photoIssues: 0,
  retryBefore: at,
  transportFailures: 0,
  resumePhase: 'photos',
  restartPass: false,
  passWaiting: 0,
  passBusy: 0,
  retryAt: null,
  failures: 0,
});
