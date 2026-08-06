import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  budgetExhausted,
  computeNextFullDueAt,
  computeNextIncrementalDueAt,
  decideTick,
  evaluateQuarantine,
  newRunBudget,
  runOverdue,
} from './alibaba-run-state.ts';

// --- schedule math -----------------------------------------------------------

test('next full due is the next Sunday 18:30 UTC strictly after the instant', () => {
  // 2026-08-06 is a Thursday; the following Sunday is 2026-08-09.
  assert.equal(computeNextFullDueAt('2026-08-06T09:00:00.000Z'), '2026-08-09T18:30:00.000Z');
  // On Sunday BEFORE 18:30 → same day.
  assert.equal(computeNextFullDueAt('2026-08-09T10:00:00.000Z'), '2026-08-09T18:30:00.000Z');
  // On Sunday exactly at 18:30 → next week (strictly after).
  assert.equal(computeNextFullDueAt('2026-08-09T18:30:00.000Z'), '2026-08-16T18:30:00.000Z');
  assert.equal(computeNextFullDueAt('2026-08-09T19:00:00.000Z'), '2026-08-16T18:30:00.000Z');
});

test('next incremental due is the next 4-hour boundary at minute 15', () => {
  assert.equal(computeNextIncrementalDueAt('2026-08-06T09:00:00.000Z'), '2026-08-06T12:15:00.000Z');
  assert.equal(computeNextIncrementalDueAt('2026-08-06T08:10:00.000Z'), '2026-08-06T08:15:00.000Z');
  assert.equal(computeNextIncrementalDueAt('2026-08-06T08:15:00.000Z'), '2026-08-06T12:15:00.000Z');
  assert.equal(computeNextIncrementalDueAt('2026-08-06T23:59:00.000Z'), '2026-08-07T00:15:00.000Z');
});

test('due-based ticks are missed-tick-proof: a LATE tick still fires', () => {
  // Watermark from hours ago; the delayed tick sees dueAt <= now and fires.
  const decision = decideTick(
    { nextIncrementalDueAt: '2026-08-06T08:15:00.000Z' },
    '2026-08-06T11:59:00.000Z',
  );
  assert.deepEqual(decision, { action: 'start-incremental' });
});

test('resume outranks everything; full outranks incremental', () => {
  assert.deepEqual(
    decideTick(
      {
        activeRunId: 'run-1',
        nextFullDueAt: '2026-08-01T00:00:00.000Z',
        nextIncrementalDueAt: '2026-08-01T00:00:00.000Z',
      },
      '2026-08-06T00:00:00.000Z',
    ),
    { action: 'resume', runId: 'run-1' },
  );
  assert.deepEqual(
    decideTick(
      {
        nextFullDueAt: '2026-08-01T00:00:00.000Z',
        nextIncrementalDueAt: '2026-08-01T00:00:00.000Z',
      },
      '2026-08-06T00:00:00.000Z',
    ),
    { action: 'start-full' },
  );
  assert.deepEqual(
    decideTick(
      {
        nextFullDueAt: '2026-08-09T18:30:00.000Z',
        nextIncrementalDueAt: '2026-08-01T00:00:00.000Z',
      },
      '2026-08-06T00:00:00.000Z',
    ),
    { action: 'start-incremental' },
  );
  assert.deepEqual(decideTick({}, '2026-08-06T00:00:00.000Z'), { action: 'idle' });
});

// --- quarantine --------------------------------------------------------------

const healthy = {
  candidateChanges: 0,
  linkedProductCount: 100,
  tombstoneCandidates: 0,
  activeSourceCount: 100,
  parseFailures: 0,
  itemsProcessed: 50,
  zeroItemFullWithActiveSources: false,
  signatureVectorFailed: false,
  responseContractFailed: false,
  unsupportedCurrency: false,
  rawEvidenceMissing: false,
  leaseOrFenceInvalid: false,
};

test('healthy runs never quarantine; each guard trips on floor AND ratio', () => {
  assert.equal(evaluateQuarantine(healthy).quarantine, false);
  // 19 changes: below the absolute floor even at 100% ratio.
  assert.equal(
    evaluateQuarantine({ ...healthy, candidateChanges: 19, linkedProductCount: 19 }).quarantine,
    false,
  );
  // 20 changes over 100 linked = 20% <= 30%: no trip.
  assert.equal(
    evaluateQuarantine({ ...healthy, candidateChanges: 20, linkedProductCount: 100 }).quarantine,
    false,
  );
  // 40 over 100 = 40% > 30%: trips.
  const tripped = evaluateQuarantine({ ...healthy, candidateChanges: 40, linkedProductCount: 100 });
  assert.equal(tripped.quarantine, true);
  assert.deepEqual(tripped.reasons, ['candidate-change-surge']);
});

test('zero denominators never trip ratios; the zero-item trigger covers empty enumerations', () => {
  // First run: 0 linked, 0 active — 0/0 must not quarantine.
  assert.equal(
    evaluateQuarantine({
      ...healthy,
      linkedProductCount: 0,
      activeSourceCount: 0,
      itemsProcessed: 10,
    }).quarantine,
    false,
  );
  // A "successful" zero-item full enumeration against a live mirror trips the
  // dedicated guard (R1 E5) even though every ratio denominator survives.
  const wiped = evaluateQuarantine({ ...healthy, zeroItemFullWithActiveSources: true });
  assert.equal(wiped.quarantine, true);
  assert.deepEqual(wiped.reasons, ['zero-item-enumeration']);
});

test('tombstone and parse-failure guards use their R1 denominators', () => {
  assert.equal(
    evaluateQuarantine({ ...healthy, tombstoneCandidates: 5, activeSourceCount: 100 }).quarantine,
    false,
    '5% <= 10%',
  );
  assert.equal(
    evaluateQuarantine({ ...healthy, tombstoneCandidates: 15, activeSourceCount: 100 }).quarantine,
    true,
  );
  assert.equal(
    evaluateQuarantine({ ...healthy, parseFailures: 5, itemsProcessed: 200 }).quarantine,
    false,
    '2.5% <= 5%',
  );
  assert.equal(
    evaluateQuarantine({ ...healthy, parseFailures: 5, itemsProcessed: 50 }).quarantine,
    true,
  );
});

test('hard guards always quarantine', () => {
  for (const key of [
    'signatureVectorFailed',
    'responseContractFailed',
    'unsupportedCurrency',
    'rawEvidenceMissing',
    'leaseOrFenceInvalid',
  ] as const) {
    assert.equal(evaluateQuarantine({ ...healthy, [key]: true }).quarantine, true, key);
  }
});

// --- budget + overdue --------------------------------------------------------

test('budget exhausts on deadline, product cap, or API-call cap', () => {
  const t0 = Date.parse('2026-08-06T09:00:00.000Z');
  const budget = newRunBudget(t0, { softDeadlineMs: 1000, maxProducts: 2, maxApiCalls: 3 });
  assert.equal(budgetExhausted(budget, t0), false);
  assert.equal(budgetExhausted(budget, t0 + 1000), true, 'deadline');
  budget.productsProcessed = 2;
  assert.equal(budgetExhausted(budget, t0), true, 'product cap');
  budget.productsProcessed = 0;
  budget.apiCalls = 3;
  assert.equal(budgetExhausted(budget, t0), true, 'api cap');
});

test('runs fail after 96 continuations or 24 hours from start', () => {
  assert.equal(runOverdue('2026-08-06T00:00:00.000Z', 95, '2026-08-06T01:00:00.000Z'), false);
  assert.equal(runOverdue('2026-08-06T00:00:00.000Z', 96, '2026-08-06T01:00:00.000Z'), true);
  assert.equal(runOverdue('2026-08-05T00:00:00.000Z', 0, '2026-08-06T00:00:00.000Z'), true);
});
