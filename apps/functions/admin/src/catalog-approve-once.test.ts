/** A whole approval in one request (publish speed, 2026-10-08). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogFailureIssue,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { type ApproveOnceDeps, approveInOneRequest } from './catalog-approve-once.ts';

const OPERATION = '12345678-1234-4234-8234-123456789012';
const progress = (nextPage: number, pages: number, complete: boolean) => ({
  ok: true,
  jobId: 'j'.repeat(64),
  revision: 'r1',
  nextPage,
  pages,
  complete,
});
const review = (unbound: string[] = [], total = 3) => ({
  ok: true,
  kind: 'review',
  productId: 'p1',
  expectedDigest: 'd'.repeat(64),
  expectedRevision: 'old',
  detail: { variants: { total, pageSize: 50 } },
  previewMedia: { importDigest: 'i'.repeat(64), variantSources: [{ unboundSources: unbound }] },
});

/** Records every server step in order; answers like the real handlers. */
function server(overrides: Partial<Record<string, unknown>> = {}, clock = { now: 0, step: 0 }) {
  const calls: Array<Record<string, unknown>> = [];
  const answer = (input: Record<string, unknown>) => {
    calls.push(input);
    clock.now += clock.step;
    const action = String(input.action);
    if (action in overrides) return overrides[action];
    if (action === 'prepare')
      return input.page === 0 ? progress(1, 2, false) : progress(2, 2, true);
    if (action === 'review') return review();
    if (action === 'begin') return progress(0, 1, false);
    if (action === 'page') return progress(1, 1, false);
    if (action === 'finish') return progress(1, 1, true);
    throw new Error(`unexpected ${action}`);
  };
  const deps: ApproveOnceDeps = {
    prepare: async (_actor, input) => answer(input as Record<string, unknown>),
    workflow: async (_actor, input) => answer(input as Record<string, unknown>),
    now: () => clock.now,
  };
  return { calls, deps };
}
const approve = (deps: ApproveOnceDeps, budget?: number) =>
  approveInOneRequest(
    'admin',
    { action: 'approve', productId: 'p1', operationId: OPERATION },
    deps,
    budget,
  );

test('one request runs prepare, review, begin, pages and finish, in that order', async () => {
  const { calls, deps } = server();
  assert.deepEqual(await approve(deps), {
    ok: true,
    status: 'approved',
    jobId: 'j'.repeat(64),
    revision: 'r1',
  });
  assert.deepEqual(
    calls.map((call) => `${call.action}${'page' in call ? `:${call.page}` : ''}`),
    ['prepare:0', 'prepare:1', 'review:1', 'begin', 'page:0', 'finish'],
  );
  // Begin approves exactly the reviewed version, under the browser's operation id.
  assert.deepEqual(calls[3], {
    action: 'begin',
    command: {
      productId: 'p1',
      expectedDigest: 'd'.repeat(64),
      expectedRevision: 'old',
      operationId: OPERATION,
    },
  });
});

test('configuration photos still to import hand the approval back before begin', async () => {
  const { calls, deps } = server({ review: review(['https://sc04.alicdn.com/black.jpg']) });
  assert.deepEqual(await approve(deps), {
    ok: true,
    status: 'needs-browser',
    reason: 'media-import',
  });
  assert.equal(
    calls.some((call) => call.action === 'begin'),
    false,
  );
});

test('later review pages are read against the first page’s digest', async () => {
  const pages: unknown[] = [];
  const { deps } = server();
  const workflow = deps.workflow;
  deps.workflow = async (actor, input) => {
    const command = input as Record<string, unknown>;
    if (command.action === 'review') {
      pages.push([command.page, command.expectedDigest]);
      return command.page === 2
        ? review(['https://sc04.alicdn.com/late.jpg'], 120)
        : review([], 120);
    }
    return workflow(actor, input);
  };
  assert.deepEqual(await approve(deps), {
    ok: true,
    status: 'needs-browser',
    reason: 'media-import',
  });
  assert.deepEqual(pages, [
    [1, undefined],
    [2, 'd'.repeat(64)],
  ]);
});

test('a very large product hands over when the time budget is spent', async () => {
  const { calls, deps } = server({}, { now: 0, step: 5_000 });
  assert.deepEqual(await approve(deps, 4_000), {
    ok: true,
    status: 'needs-browser',
    reason: 'time-budget',
  });
  assert.equal(
    calls.some((call) => call.action === 'finish'),
    false,
  );
});

test('a failing step answers exactly as it would on its own, and nothing after it runs', async () => {
  const { calls, deps } = server({ begin: { ok: false, code: 'CONFLICT' } });
  assert.deepEqual(await approve(deps), { ok: false, code: 'CONFLICT' });
  assert.equal(calls.at(-1)?.action, 'begin');
  const stalled = server({ prepare: progress(0, 2, false) });
  assert.deepEqual(await approve(stalled.deps), { ok: false, code: 'SOURCE_NOT_READY' });
  // A photo locked by another save is "busy, try again", never a validation error.
  const busy = server({ begin: { ok: false, code: 'MEDIA_BUSY' } });
  assert.deepEqual(await approve(busy.deps), { ok: false, code: 'MEDIA_BUSY' });
});

test('a malformed request or step answer is refused', async () => {
  const { deps } = server();
  assert.deepEqual(
    await approveInOneRequest('admin', { action: 'approve', productId: 'p1' }, deps),
    { ok: false, code: 'VALIDATION_ERROR' },
  );
  const odd = server({ review: { ok: true, nonsense: true } });
  assert.deepEqual(await approve(odd.deps), { ok: false, code: 'VALIDATION_ERROR' });
});

test('one-request approval preserves safe preparation diagnostics and stops before review', async () => {
  const failure = {
    ok: false,
    code: 'VALIDATION_ERROR',
    validation: {
      stage: 'source-candidate',
      issues: [
        {
          code: 'TOO_MANY',
          stage: 'effective-content',
          path: 'facts',
          severity: 'error',
          remedy: 'resync',
          expected: { maxCount: 256 },
          observed: { count: 257 },
        },
      ],
      totalIssues: 1,
    },
  };
  const result = await approveInOneRequest(
    'admin',
    { action: 'approve', productId: 'clock', operationId: '11111111-1111-4111-8111-111111111111' },
    {
      prepare: async () => failure,
      workflow: async () => {
        throw new Error('Validation failure must stop approval');
      },
      now: () => 0,
    },
  );
  assert.deepEqual(result, failure);
});

for (const stage of ['review', 'begin', 'page', 'finish'] as const)
  test(`one-request approval retains structured ${stage} failure and stops immediately`, async () => {
    const failure = catalogValidationFailure(stage, [catalogFailureIssue('VALIDATION_ERROR')]);
    const { calls, deps } = server({ [stage]: failure });
    assert.deepEqual(await approve(deps), failure);
    assert.equal(calls.at(-1)?.action, stage);
  });

test('one-request approval discards malformed diagnostic text rather than exposing it', async () => {
  const { deps } = server({
    prepare: {
      ok: false,
      code: 'VALIDATION_ERROR',
      validation: { stage: 'source-candidate', issues: ['PRIVATE_SOURCE_TOKEN'] },
    },
  });
  assert.deepEqual(await approve(deps), { ok: false, code: 'VALIDATION_ERROR' });
});
