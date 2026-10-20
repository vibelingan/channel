import { z } from 'zod';
const count = z.number().int().nonnegative().safe();
export const SyncPreparationSchema = z
  .object({
    phase: z.enum(['drafts', 'photos', 'checks', 'waiting', 'complete', 'attention']),
    cursor: z.string(),
    draftsCreated: count,
    photosCopied: count,
    photoIssues: count,
    retryBefore: z.string().datetime(),
    transportFailures: count,
    resumePhase: z.enum(['drafts', 'photos', 'checks']),
    checks: z
      .object({
        actorId: z.string().min(1).max(200),
        cursor: z.string(),
        retries: count.max(3),
        checked: count,
        issues: count,
        completed: z.boolean(),
      })
      .strict()
      .optional(),
    restartPass: z.boolean(),
    passWaiting: count,
    passBusy: count,
    retryAt: z.string().datetime().nullable(),
    failures: count,
  })
  .strict();
export type Preparation = z.infer<typeof SyncPreparationSchema>;
export const initialSyncPreparation = (
  at = new Date().toISOString(),
  actorId?: string,
): Preparation => ({
  ...(actorId
    ? { checks: { actorId, cursor: '', retries: 0, checked: 0, issues: 0, completed: false } }
    : {}),
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
