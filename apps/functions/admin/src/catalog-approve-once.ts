/**
 * A whole approval in one request: prepare → review → begin → pages → finish,
 * the same server steps and checks the browser otherwise calls one by one.
 *
 * Why: every request to CloudBase from outside mainland China spends about a
 * second (0.6–3 s measured) in the gateway, while the function itself runs in
 * tens of milliseconds. The step-by-step protocol makes eight or nine requests
 * per product; this makes one.
 *
 * It stops early, with nothing lost, when the browser must act: configuration
 * photos must be imported first (the image importer is another function), or
 * the time budget is spent on a very large product. The browser then runs the
 * step-by-step protocol with the same operation id, which resumes the same job.
 */
import { manageCatalogDetailApproval } from '@vibelingan-channel/db';
import { z } from 'zod';
import { prepareCatalogSource } from './catalog-detail-source.ts';

const RequestSchema = z
  .object({
    action: z.literal('approve'),
    productId: z.string().trim().min(1).max(200),
    operationId: z.string().uuid(),
  })
  .strict();

const Progress = z.object({
  ok: z.literal(true),
  jobId: z.string(),
  revision: z.string(),
  nextPage: z.number().int().min(0),
  pages: z.number().int().min(0),
  complete: z.boolean(),
});
const Review = z.object({
  ok: z.literal(true),
  expectedDigest: z.string(),
  expectedRevision: z.string().nullable(),
  detail: z.object({ variants: z.object({ total: z.number(), pageSize: z.number() }) }),
  previewMedia: z
    .object({
      importDigest: z.string().optional(),
      variantSources: z
        .array(z.object({ unboundSources: z.array(z.string()) }).passthrough())
        .optional(),
    })
    .passthrough()
    .optional(),
});

/** The codes the individual steps answer with; the handler maps each. */
const FAILURE_CODES = [
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'MEDIA_NOT_READY',
  'APPROVAL_TOO_LARGE',
  'SOURCE_NOT_READY',
  'MANUAL_CONFIGURATIONS',
] as const;
type Failure = { ok: false; code: (typeof FAILURE_CODES)[number] };
const asFailure = (value: object): Failure => {
  const code = Reflect.get(value, 'code');
  return {
    ok: false,
    code: FAILURE_CODES.find((known) => known === code) ?? 'VALIDATION_ERROR',
  };
};
export type ApproveOnceResult =
  | { ok: true; status: 'approved'; jobId: string; revision: string }
  | { ok: true; status: 'needs-browser'; reason: 'media-import' | 'time-budget' }
  | Failure;

export interface ApproveOnceDeps {
  prepare: (actorId: string, input: unknown) => Promise<unknown>;
  workflow: (actorId: string, input: unknown) => Promise<unknown>;
  now: () => number;
}

const defaultDeps: ApproveOnceDeps = {
  prepare: prepareCatalogSource,
  workflow: manageCatalogDetailApproval,
  now: Date.now,
};

/** Stay well inside the function's 20 s timeout. */
export const APPROVE_ONCE_BUDGET_MS = 12_000;

export async function approveInOneRequest(
  actorId: string,
  input: unknown,
  deps: ApproveOnceDeps = defaultDeps,
  budgetMs = APPROVE_ONCE_BUDGET_MS,
): Promise<ApproveOnceResult> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_ERROR' };
  const { productId, operationId } = parsed.data;
  const deadline = deps.now() + budgetMs;
  const outOfTime = () => deps.now() > deadline;
  const handOver = (reason: 'media-import' | 'time-budget'): ApproveOnceResult => ({
    ok: true,
    status: 'needs-browser',
    reason,
  });
  /** A step's own failure passes through unchanged; anything else is invalid. */
  const step = async <T>(
    schema: z.ZodType<T>,
    result: Promise<unknown>,
  ): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> => {
    const value = await result;
    if (value && typeof value === 'object' && Reflect.get(value, 'ok') === false)
      return { ok: false, failure: asFailure(value) };
    const checked = schema.safeParse(value);
    return checked.success
      ? { ok: true, value: checked.data }
      : { ok: false, failure: asFailure({ code: 'VALIDATION_ERROR' }) };
  };

  // 1. Prepare every source page (resumable: completed pages short-circuit).
  for (let page = 0, attempts = 0; ; attempts++) {
    if (attempts >= 500) return { ok: false, code: 'SOURCE_NOT_READY' };
    const prepared = await step(
      Progress,
      deps.prepare(actorId, { action: 'prepare', productId, page }),
    );
    if (!prepared.ok) return prepared.failure;
    if (prepared.value.complete) break;
    if (prepared.value.nextPage <= page || prepared.value.nextPage >= prepared.value.pages)
      return { ok: false, code: 'SOURCE_NOT_READY' };
    page = prepared.value.nextPage;
    if (outOfTime()) return handOver('time-budget');
  }

  // 2. Review every page; configuration photos not yet imported go to the browser.
  const reviewPage = (page: number, expectedDigest?: string) =>
    step(
      Review,
      deps.workflow(actorId, {
        action: 'review',
        productId,
        page,
        includePreviewMedia: true,
        ...(expectedDigest ? { expectedDigest } : {}),
      }),
    );
  const first = await reviewPage(1);
  if (!first.ok) return first.failure;
  const review = first.value;
  const unbound = (value: z.infer<typeof Review>) =>
    (value.previewMedia?.variantSources ?? []).some((entry) => entry.unboundSources.length > 0);
  if (unbound(review)) return handOver('media-import');
  const reviewPages = Math.ceil(review.detail.variants.total / review.detail.variants.pageSize);
  for (let page = 2; page <= reviewPages; page++) {
    const next = await reviewPage(page, review.expectedDigest);
    if (!next.ok) return next.failure;
    if (unbound(next.value)) return handOver('media-import');
    if (outOfTime()) return handOver('time-budget');
  }

  // 3. Begin (same operation id → the same job), stage pages, finish.
  const begun = await step(
    Progress,
    deps.workflow(actorId, {
      action: 'begin',
      command: {
        productId,
        expectedDigest: review.expectedDigest,
        expectedRevision: review.expectedRevision,
        operationId,
      },
    }),
  );
  if (!begun.ok) return begun.failure;
  let progress = begun.value;
  for (let attempts = 0; !progress.complete && progress.nextPage < progress.pages; attempts++) {
    if (attempts >= 500) return { ok: false, code: 'CONFLICT' };
    if (outOfTime()) return handOver('time-budget');
    const staged = await step(
      Progress,
      deps.workflow(actorId, { action: 'page', jobId: progress.jobId, page: progress.nextPage }),
    );
    if (!staged.ok) return staged.failure;
    if (staged.value.jobId !== progress.jobId || staged.value.nextPage <= progress.nextPage)
      return { ok: false, code: 'CONFLICT' };
    progress = staged.value;
  }
  if (!progress.complete) {
    const finished = await step(
      Progress,
      deps.workflow(actorId, { action: 'finish', jobId: progress.jobId }),
    );
    if (!finished.ok) return finished.failure;
    progress = finished.value;
  }
  if (!progress.complete) return { ok: false, code: 'CONFLICT' };
  return { ok: true, status: 'approved', jobId: progress.jobId, revision: progress.revision };
}
