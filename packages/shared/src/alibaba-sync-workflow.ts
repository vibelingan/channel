import { z } from 'zod';
const count = z.number().int().nonnegative().safe();
export const AlibabaSyncWorkflowSchema = z
  .object({
    version: z.literal('alibaba-sync-workflow-v1'),
    enabled: z.boolean(),
    phase: z.enum(['idle', 'queued', 'syncing', 'preparing', 'waiting', 'complete', 'attention']),
    runId: z.string().nullable(),
    startedAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    processed: count,
    draftsCreated: count,
    photosCopied: count,
    photoIssues: count,
    nextRetryAt: z.string().nullable(),
    issue: z
      .enum(['supplier-data', 'supplier-unavailable', 'photos', 'preparation', 'run-expired'])
      .nullable(),
    history: z
      .array(
        z
          .object({
            id: z.string(),
            startedAt: z.string().nullable(),
            result: z.enum(['in-progress', 'imported', 'complete', 'attention']),
            processed: count,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type AlibabaSyncWorkflow = z.infer<typeof AlibabaSyncWorkflowSchema>;
