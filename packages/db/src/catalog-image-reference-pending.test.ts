import assert from 'node:assert/strict';
import test from 'node:test';
import * as references from './catalog-image-references.ts';
const root = (n: number) => n.toString(16).padStart(64, '0');
const stage = references.stageCatalogImageReference;
const build = references.buildCatalogImageReferencePlan;
const entry = references.catalogImageReferenceEntry;
const empty = (epoch = 0): references.CatalogImageReferenceLedger => ({
  version: 'catalog-image-reference-ledger-v1',
  epoch,
  pending: [],
});
function failure(run: () => unknown, code: string) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof references.CatalogImageReferenceError);
    assert.equal(error.code, code);
    return true;
  });
}
for (const base of [0, 7, Number.MAX_SAFE_INTEGER])
  test(`pending staging preserves explicit base ${base} and grants no additional references`, () => {
    const plan = build(root(1), [], ['image']);
    const result = stage('image', base, undefined, entry(plan, 0));
    assert.equal(result.staged, true);
    assert.equal(result.ledger.epoch, 1);
    assert.deepEqual(result.ledger.pending, [entry(plan, 0)]);
    assert.equal(
      references.planImageReferenceSettlement(
        'image',
        base,
        result.ledger,
        new Map([[plan.proof._id, null]]),
      ).effectiveCount,
      base,
    );
  });
test('replaying the exact root and membership is read-only and does not advance epoch', () => {
  const plan = build(root(1), [], ['image']);
  const first = stage('image', 0, empty(4), entry(plan, 0));
  const replay = stage('image', 0, first.ledger, entry(plan, 0));
  assert.equal(first.ledger.epoch, 5);
  assert.equal(replay.staged, false);
  assert.deepEqual(replay.ledger, first.ledger);
});
for (const base of [
  undefined,
  null,
  '0',
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])
  test(`pending staging cannot guess an unknown or corrupt base ${String(base)}`, () => {
    const plan = build(root(1), [], ['image']);
    failure(() => stage('image', base, undefined, entry(plan, 0)), 'INVALID_COUNT');
  });
for (const invalid of [
  null,
  {},
  { version: 'wrong', epoch: 0, pending: [] },
  { ...empty(), epoch: -1 },
  { ...empty(), epoch: Number.MAX_SAFE_INTEGER + 1 },
])
  test(`pending staging refuses a corrupt existing ledger ${JSON.stringify(invalid)}`, () => {
    const plan = build(root(1), [], ['image']);
    const before = structuredClone(invalid);
    failure(() => stage('image', 0, invalid, entry(plan, 0)), 'INVALID_LEDGER');
    assert.deepEqual(invalid, before);
  });
for (const mutation of ['other-image', 'delta', 'index', 'siblings', 'extra'] as const)
  test(`new pending membership refuses ${mutation} without changing the input ledger`, () => {
    const plan = build(root(1), [], ['image', 'other']);
    const incoming = entry(plan, 0);
    const ledger = empty(4);
    if (mutation === 'delta') Reflect.set(incoming, 'delta', 0);
    if (mutation === 'index') incoming.index = 1;
    if (mutation === 'siblings') incoming.siblings[0] = 'f'.repeat(64);
    if (mutation === 'extra') Reflect.set(incoming, 'future', 'unreviewed');
    failure(
      () => stage(mutation === 'other-image' ? 'other' : 'image', 0, ledger, incoming),
      'INVALID_PLAN',
    );
    assert.deepEqual(ledger, empty(4));
  });
for (const opposite of [false, true])
  test(`one operation cannot replace its existing commitment, opposite=${opposite}`, () => {
    const first = build(root(1), [], ['image']);
    const other = opposite ? build(root(1), ['image'], []) : build(root(1), [], ['image', 'other']);
    const ledger = stage('image', 0, undefined, entry(first, 0)).ledger;
    const before = structuredClone(ledger);
    failure(() => stage('image', 0, ledger, entry(other, 0)), 'INVALID_PLAN');
    assert.deepEqual(ledger, before);
  });
test('79 pending roots admit the80th, exact replay is allowed at80, and81st is retryable full', () => {
  let ledger = empty();
  const plans = Array.from({ length: 81 }, (_, i) => build(root(i + 1), [], ['image']));
  for (const plan of plans.slice(0, 80)) ledger = stage('image', 0, ledger, entry(plan, 0)).ledger;
  assert.equal(ledger.pending.length, 80);
  assert.equal(ledger.epoch, 80);
  const last = plans[79];
  const next = plans[80];
  assert.ok(last && next);
  assert.equal(stage('image', 0, ledger, entry(last, 0)).staged, false);
  const before = structuredClone(ledger);
  failure(() => stage('image', 0, ledger, entry(next, 0)), 'PENDING_FULL');
  assert.deepEqual(ledger, before);
});
test('settling all80 cancelled roots frees a slot without changing the base or dropping another root', () => {
  let ledger = empty(4);
  const proofs = new Map<string, unknown>();
  for (let i = 1; i <= 80; i++) {
    const plan = build(root(i), [], ['image']);
    ledger = stage('image', 7, ledger, entry(plan, 0)).ledger;
    proofs.set(plan.proof._id, references.catalogImageReferenceCancelProof(plan.proof));
  }
  const settled = references.planImageReferenceSettlement('image', 7, ledger, proofs);
  assert.ok(settled.settlement);
  assert.equal(settled.effectiveCount, 7);
  assert.equal(settled.settlement.ledger.pending.length, 0);
  const next = build(root(100), [], ['image']);
  const appended = stage(
    'image',
    settled.settlement.publishedRefCount,
    settled.settlement.ledger,
    entry(next, 0),
  );
  assert.equal(appended.ledger.pending.length, 1);
  assert.equal(appended.ledger.epoch, 86);
  assert.equal(
    references.planImageReferenceSettlement(
      'image',
      7,
      appended.ledger,
      new Map([[next.proof._id, null]]),
    ).effectiveCount,
    7,
  );
});
test('settlement followed by staging preserves every still-unconfirmed root', () => {
  const first = build(root(1), [], ['image']);
  const missing = build(root(2), [], ['image']);
  const next = build(root(3), [], ['image']);
  let ledger = stage('image', 0, undefined, entry(first, 0)).ledger;
  ledger = stage('image', 0, ledger, entry(missing, 0)).ledger;
  const settlement = references.planImageReferenceSettlement(
    'image',
    0,
    ledger,
    new Map([
      [first.proof._id, first.proof],
      [missing.proof._id, null],
    ]),
  );
  assert.ok(settlement.settlement);
  const result = stage('image', 1, settlement.settlement.ledger, entry(next, 0));
  assert.deepEqual(result.ledger.pending, [entry(missing, 0), entry(next, 0)]);
});
test('epoch overflow refuses a new change but still permits exact read-only replay', () => {
  const first = build(root(1), [], ['image']);
  const next = build(root(2), [], ['image']);
  const ledger = { ...empty(Number.MAX_SAFE_INTEGER), pending: [entry(first, 0)] };
  assert.equal(stage('image', 0, ledger, entry(first, 0)).staged, false);
  failure(() => stage('image', 0, ledger, entry(next, 0)), 'INVALID_LEDGER');
});
test('staging validates all existing members and duplicate roots before an apparent replay', () => {
  const plan = build(root(1), [], ['image', 'other']);
  const member = entry(plan, 0);
  const corrupt = { ...member, siblings: ['f'.repeat(64)] };
  failure(() => stage('image', 0, { ...empty(), pending: [corrupt] }, member), 'INVALID_LEDGER');
  failure(
    () => stage('image', 0, { ...empty(), pending: [member, member] }, member),
    'INVALID_LEDGER',
  );
});
test('input ledger and incoming sibling arrays remain independent of returned mutable values', () => {
  const first = build(root(1), [], ['image', 'other']);
  const second = build(root(2), [], ['image', 'other']);
  const incoming = entry(second, 0);
  const ledger = stage('image', 0, empty(), entry(first, 0)).ledger;
  const before = structuredClone({ ledger, incoming });
  const result = stage('image', 0, ledger, incoming);
  result.ledger.pending[0]?.siblings.push('f'.repeat(64));
  result.ledger.pending[1]?.siblings.push('f'.repeat(64));
  result.ledger.pending.pop();
  assert.deepEqual({ ledger, incoming }, before);
});
test('80 maximum-depth member paths fit the existing128KiB ledger budget', () => {
  const ids = Array.from({ length: 65536 }, (_, i) => `image-${String(i).padStart(5, '0')}`);
  const plan = build(root(1), [], ids);
  const initial = entry(plan, 0);
  let ledger = empty();
  for (let i = 1; i <= 80; i++)
    ledger = stage(ids[0] ?? '', 0, ledger, { ...initial, operationRootId: root(i) }).ledger;
  assert.equal(ledger.pending.length, 80);
  assert.equal(ledger.pending[0]?.siblings.length, 16);
  assert.ok(
    Buffer.byteLength(JSON.stringify(ledger)) <=
      references.CATALOG_IMAGE_REFERENCE_LEDGER_MAX_BYTES,
  );
});
