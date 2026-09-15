import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlibabaSyncApiError, type TickReport, runSyncToTerminal } from './alibaba-api.ts';

function sequence(reports: TickReport[]): () => Promise<TickReport> {
  let index = 0;
  return async () => {
    const report = reports[index];
    if (!report) throw new Error('unexpected extra tick');
    index += 1;
    return report;
  };
}

test('one admin action resumes bounded ticks until the same run completes', async () => {
  const progress: string[] = [];
  const result = await runSyncToTerminal({
    tick: sequence([
      { outcome: 'continued', runId: 'incremental-1' },
      { outcome: 'continued', runId: 'incremental-1' },
      { outcome: 'completed', runId: 'incremental-1' },
    ]),
    onProgress: (report, ticks) => progress.push(`${ticks}:${report.outcome}`),
  });

  assert.deepEqual(result, {
    report: { outcome: 'completed', runId: 'incremental-1' },
    ticks: 3,
  });
  assert.deepEqual(progress, ['1:continued', '2:continued', '3:completed']);
});

test('terminal outcomes stop without issuing another worker tick', async () => {
  let calls = 0;
  const result = await runSyncToTerminal({
    tick: async () => {
      calls += 1;
      return { outcome: 'quarantined', runId: 'incremental-2' };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.report.outcome, 'quarantined');
});

test('continuation fails closed when its run id is absent or changes', async () => {
  await assert.rejects(
    runSyncToTerminal({ tick: sequence([{ outcome: 'continued' }]) }),
    (error: unknown) => error instanceof AlibabaSyncApiError && error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    runSyncToTerminal({
      tick: sequence([
        { outcome: 'continued', runId: 'incremental-a' },
        { outcome: 'continued', runId: 'incremental-b' },
      ]),
    }),
    (error: unknown) => error instanceof AlibabaSyncApiError && error.code === 'INVALID_RESPONSE',
  );
  await assert.rejects(
    runSyncToTerminal({
      tick: sequence([
        { outcome: 'continued', runId: 'incremental-a' },
        { outcome: 'completed', runId: 'incremental-b' },
      ]),
    }),
    (error: unknown) => error instanceof AlibabaSyncApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('continuation cap stops runaway client loops', async () => {
  let calls = 0;
  await assert.rejects(
    runSyncToTerminal({
      maxTicks: 2,
      tick: async () => {
        calls += 1;
        return { outcome: 'continued', runId: 'incremental-3' };
      },
    }),
    (error: unknown) => error instanceof AlibabaSyncApiError && error.code === 'CONTINUATION_LIMIT',
  );
  assert.equal(calls, 2);
});
