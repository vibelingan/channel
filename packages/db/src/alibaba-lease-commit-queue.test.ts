import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { withAlibabaLeaseCommit } from './alibaba-lease-commit-queue.ts';

const owner = { connectionId: 'primary', holder: 'holder-A', fence: 1 };
function latch() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, held };
}

test('same lease owner queues commits and retains each exact result', async () => {
  const gate = latch();
  const started: number[] = [];
  const first = withAlibabaLeaseCommit(owner, async () => {
    started.push(1);
    await gate.held;
    return 'first';
  });
  const second = withAlibabaLeaseCommit(owner, async () => {
    started.push(2);
    return 'second';
  });
  const third = withAlibabaLeaseCommit(owner, async () => {
    started.push(3);
    return 'third';
  });
  await setImmediate();
  assert.deepEqual(started, [1]);
  gate.release();
  assert.deepEqual(await Promise.all([first, second, third]), ['first', 'second', 'third']);
  assert.deepEqual(started, [1, 2, 3]);
});

for (const different of [
  { ...owner, connectionId: 'other' },
  { ...owner, holder: 'holder-B' },
  { ...owner, fence: 2 },
])
  test(`independent lease ${JSON.stringify(different)} does not wait for a held commit`, async () => {
    const gate = latch();
    const first = withAlibabaLeaseCommit(owner, () => gate.held);
    let entered = false;
    const independent = withAlibabaLeaseCommit(different, async () => {
      entered = true;
      return 'independent';
    });
    await setImmediate();
    try {
      assert.equal(entered, true);
      assert.equal(await independent, 'independent');
    } finally {
      gate.release();
      await first;
    }
  });

test('a failed commit releases the next commit without swallowing the failure', async () => {
  const gate = latch();
  const failure = new Error('synthetic database rejection');
  const first = withAlibabaLeaseCommit(owner, async () => {
    await gate.held;
    throw failure;
  });
  const rejected = assert.rejects(first, (error) => error === failure);
  const second = withAlibabaLeaseCommit(owner, async () => 'recovered');
  gate.release();
  await rejected;
  assert.equal(await second, 'recovered');
  assert.equal(await withAlibabaLeaseCommit(owner, async () => 'new operation'), 'new operation');
});
