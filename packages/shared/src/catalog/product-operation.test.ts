import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
  CatalogProductOperationBindingSchema,
  CatalogProductOperationStatusSchema,
  CatalogReferenceRecoveryCursorSchema,
} from './product-operation.ts';
const at = '2026-10-18T00:00:00.000Z';
const base = {
  ok: true,
  kind: 'product-operation',
  state: 'reserved',
  productId: 'p',
  operationId: '12345678-1234-4234-8234-123456789012',
  intent: 'publish',
  inputDigest: 'a'.repeat(64),
  createdAt: at,
  current: true,
  revisionCurrent: true,
  expired: false,
};
const saved = { at, productUpdatedAt: at };
const approval = {
  revision: 'r1',
  configurations: { completed: 2, total: 2 },
  mediaReady: true,
  references: { prepared: true, staged: 20, total: 20 },
};
const complete = {
  ...base,
  state: 'complete',
  saved,
  approval,
  completion: { at, productUpdatedAt: at, revision: 'r1', published: true },
};
for (const state of ['reserved', 'saved', 'staging', 'complete'])
  test(`operation status schema accepts only bounded ${state} fields`, () => {
    const status =
      state === 'complete'
        ? complete
        : state === 'staging'
          ? { ...base, state, saved, approval }
          : state === 'saved'
            ? { ...base, state, saved }
            : { ...base, state };
    assert.ok(CatalogProductOperationStatusSchema.safeParse(status).success);
    assert.ok(
      Buffer.byteLength(JSON.stringify(status)) <= CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
    );
    for (const key of ['record', 'values', 'publication', 'source', 'media', 'references'])
      assert.equal(
        CatalogProductOperationStatusSchema.safeParse({ ...status, [key]: { secret: 'not a DTO' } })
          .success,
        false,
      );
  });
for (const patch of [
  { approval: { ...approval, configurations: { completed: 3, total: 2 } } },
  { approval: { ...approval, references: { prepared: true, staged: 21, total: 20 } } },
  { approval: { ...approval, references: { prepared: false, staged: 0, total: 20 } } },
  { approval: { ...approval, configurations: { completed: 1, total: 2 } } },
  { approval: { ...approval, mediaReady: false } },
  { approval: { ...approval, references: { prepared: true, staged: 19, total: 20 } } },
  { completion: { at, productUpdatedAt: at, revision: 'another', published: true } },
  { cancelledAt: at },
  { completion: { at, productUpdatedAt: at, revision: 'r1', published: false } },
])
  test(`operation complete status refuses inconsistent progress ${JSON.stringify(patch)}`, () => {
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({ ...complete, ...patch }).success,
      false,
    );
  });
test('largest encoded identifier status remains below the response budget', () => {
  const status = {
    ...complete,
    productId: '中'.repeat(200),
    approval: { ...approval, revision: '中'.repeat(200) },
    completion: { ...complete.completion, revision: '中'.repeat(200) },
  };
  assert.ok(CatalogProductOperationStatusSchema.safeParse(status).success);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) < CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES);
});

for (const progress of [
  { ...approval, configurations: { completed: 3, total: 2 } },
  { ...approval, references: { prepared: true, staged: 21, total: 20 } },
  { ...approval, references: { prepared: false, staged: 0, total: 20 } },
])
  test(`staging status refuses inconsistent progress ${JSON.stringify(progress)}`, () => {
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({
        ...base,
        state: 'staging',
        saved,
        approval: progress,
      }).success,
      false,
    );
  });

test('owned continuation binding contains only the exact original operation identity', () => {
  const binding = {
    productId: '中'.repeat(200),
    operationId: base.operationId,
    inputDigest: base.inputDigest,
  };
  assert.deepEqual(CatalogProductOperationBindingSchema.parse(binding), binding);
});
for (const extra of [
  { actorId: 'other' },
  { values: {} },
  { prepared: {} },
  { inputDigest: 'wrong' },
  { operationId: 'wrong' },
  { productId: 'x'.repeat(201) },
])
  test(`owned continuation binding refuses ${JSON.stringify(extra)}`, () => {
    assert.equal(
      CatalogProductOperationBindingSchema.safeParse({
        productId: 'p',
        operationId: base.operationId,
        inputDigest: base.inputDigest,
        ...extra,
      }).success,
      false,
    );
  });

for (const state of ['saved', 'staging'])
  test(`a ${state} operation accepts only bounded media preparation progress`, () => {
    const value = {
      ...base,
      state,
      saved,
      ...(state === 'staging' ? { approval: { ...approval, mediaReady: false } } : {}),
      preparation: {
        nextAction: 'wait',
        job: { id: 'b'.repeat(64), leaseVersion: 1 },
        progress: { checked: 4, total: 105 },
      },
    };
    assert.ok(CatalogProductOperationStatusSchema.safeParse(value).success);
    assert.ok(
      Buffer.byteLength(JSON.stringify(value)) < CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
    );
    for (const patch of [
      { record: {} },
      { nextAction: 'ready' },
      { progress: { checked: 106, total: 105 } },
      { job: { id: 'bad', leaseVersion: 1 } },
    ])
      assert.equal(
        CatalogProductOperationStatusSchema.safeParse({
          ...value,
          preparation: { ...value.preparation, ...patch },
        }).success,
        false,
      );
  });
for (const value of [base, complete])
  test(`a ${value.state} operation cannot carry an active preparation hint`, () => {
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({
        ...value,
        preparation: { nextAction: 'continue', job: null, progress: null },
      }).success,
      false,
    );
  });

test('media preparation hints reject stale operations, ready-media stages and unscoped progress', () => {
  const hint = {
    nextAction: 'wait',
    job: { id: 'b'.repeat(64), leaseVersion: 1 },
    progress: { checked: 4, total: 105 },
  };
  const status = {
    ...base,
    state: 'staging',
    saved,
    approval: { ...approval, mediaReady: false },
    preparation: hint,
  };
  for (const patch of [
    { current: false },
    { revisionCurrent: false },
    { expired: true },
    { cancelledAt: at },
    { intent: 'save-draft' },
    { approval },
    { preparation: { ...hint, job: null } },
    { preparation: { nextAction: 'retry', job: null, progress: null } },
  ])
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({ ...status, ...patch }).success,
      false,
    );
});
test('largest legal media preparation status stays inside the original small response budget', () => {
  const status = {
    ...base,
    productId: '\u0001'.repeat(200),
    state: 'staging',
    saved,
    approval: { ...approval, revision: '\u0001'.repeat(200), mediaReady: false },
    preparation: {
      nextAction: 'wait',
      job: { id: 'f'.repeat(64), leaseVersion: Number.MAX_SAFE_INTEGER },
      progress: { checked: 65536, total: 65536 },
    },
  };
  assert.ok(CatalogProductOperationStatusSchema.safeParse(status).success);
  assert.ok(
    Buffer.byteLength(JSON.stringify(status)) <= CATALOG_PRODUCT_OPERATION_STATUS_MAX_BYTES,
  );
});

const referenceCursor = { imageId: 'image', ledgerDigest: 'a'.repeat(64), nextOffset: 79 };
const referenceWaiting = {
  ...base,
  state: 'staging',
  saved,
  approval: { ...approval, references: { prepared: true, staged: 20, total: 21 } },
  referenceRecovery: { nextAction: 'wait', cursor: referenceCursor },
};
test('a reference wait exposes only a bounded original recovery cursor', () => {
  assert.ok(CatalogProductOperationStatusSchema.safeParse(referenceWaiting).success);
  for (const patch of [
    { nextOffset: 80 },
    { nextOffset: -1 },
    { ledgerDigest: 'bad' },
    { imageId: '' },
    { root: {} },
    { nextOffset: 1.1 },
  ])
    assert.equal(
      CatalogReferenceRecoveryCursorSchema.safeParse({ ...referenceCursor, ...patch }).success,
      false,
    );
  assert.ok(
    CatalogProductOperationStatusSchema.safeParse({
      ...referenceWaiting,
      referenceRecovery: { nextAction: 'wait', cursor: null },
    }).success,
  );
});
for (const patch of [
  { state: 'reserved' },
  { state: 'saved' },
  { current: false },
  { revisionCurrent: false },
  { expired: true },
  { cancelledAt: at },
  { approval: { ...referenceWaiting.approval, mediaReady: false } },
  {
    approval: {
      ...referenceWaiting.approval,
      references: { prepared: false, staged: 0, total: 0 },
    },
  },
  { approval },
  { ...complete },
])
  test(`reference recovery cannot decorate stale or completed work ${JSON.stringify(patch)}`, () =>
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({ ...referenceWaiting, ...patch }).success,
      false,
    ));
test('largest reference wait and legal cursor stay within the response budget', () => {
  const value = {
    ...referenceWaiting,
    productId: '\u0000'.repeat(200),
    approval: { ...referenceWaiting.approval, revision: '\u0000'.repeat(200) },
    referenceRecovery: {
      nextAction: 'wait',
      cursor: { ...referenceCursor, imageId: '中'.repeat(200) },
    },
  };
  assert.ok(CatalogProductOperationStatusSchema.safeParse(value).success);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 4096);
});

test('reference recovery cursor enforces its existing 1024-byte encoded input budget', () => {
  assert.equal(
    CatalogReferenceRecoveryCursorSchema.safeParse({
      ...referenceCursor,
      imageId: '\u0000'.repeat(200),
    }).success,
    false,
  );
});

test('reference recovery requires every configuration page to be completed', () => {
  assert.equal(
    CatalogProductOperationStatusSchema.safeParse({
      ...referenceWaiting,
      approval: { ...referenceWaiting.approval, configurations: { completed: 1, total: 2 } },
    }).success,
    false,
  );
});

test('live refresh accepts preparation and final-reference recovery under the same strict status guards', () => {
  assert.ok(
    CatalogProductOperationStatusSchema.safeParse({ ...referenceWaiting, intent: 'refresh-live' })
      .success,
  );
  assert.ok(
    CatalogProductOperationStatusSchema.safeParse({
      ...base,
      intent: 'refresh-live',
      state: 'saved',
      saved,
      preparation: { nextAction: 'wait', job: null, progress: null },
    }).success,
  );
});

test('live reserved save progress and full-slot wait remain bounded and cannot decorate another phase', () => {
  const value = {
    ...base,
    intent: 'refresh-live',
    saveReferences: { prepared: true, staged: 20, total: 63 },
    referenceRecovery: { nextAction: 'wait', cursor: referenceCursor },
  };
  assert.ok(CatalogProductOperationStatusSchema.safeParse(value).success);
  for (const patch of [
    { intent: 'publish' },
    { intent: 'save-draft' },
    { state: 'saved', saved },
    { current: false },
    { revisionCurrent: false },
    { expired: true },
    { cancelledAt: at },
    { saveReferences: { prepared: true, staged: 64, total: 64 } },
    { saveReferences: { prepared: true, staged: 21, total: 20 } },
    { saveReferences: { prepared: false, staged: 0, total: 63 } },
    { saveReferences: { prepared: true, staged: 63, total: 63 } },
  ])
    assert.equal(
      CatalogProductOperationStatusSchema.safeParse({ ...value, ...patch }).success,
      false,
    );
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 4096);
});
