import assert from 'node:assert/strict';
import test from 'node:test';
import { journalDummyDelivery } from './release-drill/journal.mjs';
import { component, memoryStore, policy, runner } from './release-state-fixtures.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

async function setup() {
  const store = memoryStore();
  const coordinator = createReleaseCoordinator({ store, policy });
  await journalDummyDelivery({
    coordinator,
    owner: runner('A'),
    runId: 'A',
    adopt: true,
    composition: { static: component('A'), 'function:seo-release-dummy': component('A') },
    verify: async () => {},
  });
  return { store, coordinator };
}
test('the real journal records intent before dummy code delivery and keeps the genuine retained site reference', async () => {
  const { coordinator } = await setup();
  let writes = 0;
  let verifications = 0;
  await journalDummyDelivery({
    coordinator,
    owner: runner('B'),
    runId: 'B',
    composition: { 'function:seo-release-dummy': component('B') },
    write: async () => {
      writes++;
      const state = await coordinator.status();
      assert.equal(state.pendingStep.component, 'function:seo-release-dummy');
      assert.equal(state.pendingStep.state, 'intent');
    },
    verify: async () => {
      verifications++;
    },
  });
  const accepted = await coordinator.runStatus('B');
  assert.equal(accepted.state, 'SUCCEEDED');
  assert.equal(writes, 1);
  assert.equal(verifications, 2);
  assert.deepEqual(accepted.composition.static, component('A'));
  assert.equal((await coordinator.status()).state, 'idle');
});
test('an unconfirmed dummy write stays unresolved and cannot launch a second deployment', async () => {
  const { coordinator } = await setup();
  let writes = 0;
  const run = () =>
    journalDummyDelivery({
      coordinator,
      owner: runner('B'),
      runId: 'B',
      composition: { 'function:seo-release-dummy': component('B') },
      write: async () => {
        writes++;
        throw Error('Lost acknowledgement');
      },
      verify: async () => {},
    });
  await assert.rejects(run());
  const status = await coordinator.status();
  assert.equal(status.pendingStep.state, 'unknown');
  await assert.rejects(run());
  assert.equal(writes, 1);
});
