import assert from 'node:assert/strict';
import test from 'node:test';
import { readPreparationTask, savePreparationTask } from './catalog-preparation-task.ts';

function storage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}
const jobId = 'a'.repeat(64);
test('task recovery is scoped to the same actor and product and stores no credentials or content', () => {
  const s = storage();
  assert.equal(savePreparationTask(s, 'admin', 'clock', jobId), true);
  assert.equal(readPreparationTask(s, 'admin', 'clock'), jobId);
  assert.equal(readPreparationTask(s, 'other', 'clock'), null);
  assert.equal(readPreparationTask(s, 'admin', 'other'), null);
  assert.equal(s.rows.size, 1);
  const value = [...s.rows.values()][0];
  assert.ok(value);
  assert.deepEqual(JSON.parse(value), {
    schemaVersion: 'catalog-preparation-task-v1',
    productId: 'clock',
    jobId,
  });
});
test('storage key boundaries cannot collide when actor and product contain separators', () => {
  const s = storage();
  assert.equal(savePreparationTask(s, 'a:b', 'c', jobId), true);
  assert.equal(savePreparationTask(s, 'a', 'b:c', 'b'.repeat(64)), true);
  assert.equal(s.rows.size, 2);
  assert.equal(readPreparationTask(s, 'a:b', 'c'), jobId);
  assert.equal(readPreparationTask(s, 'a', 'b:c'), 'b'.repeat(64));
});
for (const raw of [
  'null',
  '{',
  'x'.repeat(4096),
  JSON.stringify({ schemaVersion: 'old', productId: 'clock', jobId }),
  JSON.stringify({ schemaVersion: 'catalog-preparation-task-v1', productId: 'other', jobId }),
  JSON.stringify({
    schemaVersion: 'catalog-preparation-task-v1',
    productId: 'clock',
    jobId,
    token: 'private',
  }),
]) {
  test(`invalid task record stays unverified (${raw.length} bytes)`, () => {
    const s = storage();
    savePreparationTask(s, 'admin', 'clock', jobId);
    const key = [...s.rows.keys()][0];
    assert.ok(key);
    s.rows.set(key, raw);
    assert.equal(readPreparationTask(s, 'admin', 'clock'), null);
  });
}
test('unavailable browser storage preserves honest in-memory fallback instead of throwing', () => {
  const s = {
    getItem: () => {
      throw Error('denied');
    },
    setItem: () => {
      throw Error('quota');
    },
  };
  assert.equal(readPreparationTask(s, 'admin', 'clock'), null);
  assert.equal(savePreparationTask(s, 'admin', 'clock', jobId), false);
});
test('invalid identifiers never write a task or consult storage', () => {
  let calls = 0;
  const s = {
    getItem: () => {
      calls++;
      return null;
    },
    setItem: () => {
      calls++;
    },
  };
  for (const [actor, product, job] of [
    ['', 'clock', jobId],
    ['admin', ' clock', jobId],
    ['admin', 'clock', 'bad'],
  ]) {
    assert.equal(savePreparationTask(s, actor, product, job), false);
  }
  assert.equal(readPreparationTask(s, '', 'clock'), null);
  assert.equal(calls, 0);
});

test('one operator can alternate between two products without replacing either recovery task', () => {
  const s = storage();
  const secondJob = 'b'.repeat(64);
  assert.equal(savePreparationTask(s, 'admin', 'clock', jobId), true);
  assert.equal(savePreparationTask(s, 'admin', 'headphones', secondJob), true);
  assert.equal(s.rows.size, 2);
  assert.equal(readPreparationTask(s, 'admin', 'clock'), jobId);
  assert.equal(readPreparationTask(s, 'admin', 'headphones'), secondJob);
  assert.equal(savePreparationTask(s, 'admin', 'clock', 'c'.repeat(64)), true);
  assert.equal(readPreparationTask(s, 'admin', 'headphones'), secondJob);
});
