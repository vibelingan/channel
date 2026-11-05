import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { captureCatalogRegionalInput } from './catalog-regional-capture.mjs';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { clock, composition, plan, policy, receipt, stepInput } from './release-state-fixtures.mjs';
import { assertCleanAcceptedSite } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const require = createRequire(new URL('../apps/site/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { prepareProducts, withProductReleaseCoordinator } = await tsImport(
  './blog/prepare-products.ts',
  import.meta.url,
);
const owner = {
  ownerRunId: 'site-41300590230-1',
  runnerRef: 'github:vibelingan/channel:41300590230:attempt-1',
};
const config = { siteOrigin: policy.siteOrigin, detailEnabled: true };
const stopped = (code) => Object.assign(Error(code), { code });

async function fixture(t) {
  const database = cloudbaseFixture(t);
  const time = clock();
  const actual = createReleaseCoordinator({ store: database.store, policy, clock: time.now });
  const acceptedGuard = await actual.acquire({
    ownerRunId: 'accepted',
    runnerRef: 'previous-runner',
  });
  await actual.startRun({
    guard: acceptedGuard,
    runId: 'accepted',
    scopeKey: 'site',
    kind: 'adopt',
    plan: plan(1),
    composition: composition(),
  });
  const step = await actual.beginStep({
    guard: acceptedGuard,
    runId: 'accepted',
    ...stepInput('accept'),
  });
  await actual.confirmStep({
    guard: acceptedGuard,
    runId: 'accepted',
    stepId: step.stepId,
    receipt: receipt(step),
  });
  await actual.commitRun({
    guard: acceptedGuard,
    runId: 'accepted',
    changeSetRef: 'accepted fixture',
  });
  const baseline = (await actual.status()).scope.baseline;
  const events = [];
  const f = { actual, baseline, events, timerActive: false };
  const coordinator = {
    targetId: actual.targetId,
    status: (...args) => actual.status(...args),
    acquire: async (...args) => {
      events.push('acquire');
      return actual.acquire(...args);
    },
    renew: async (...args) => {
      events.push('renew');
      return actual.renew(...args);
    },
    release: async (...args) => {
      assert.equal(f.timerActive, false, 'heartbeat must drain before lease release');
      events.push('release-start');
      const result = await actual.release(...args);
      events.push('release-complete');
      return result;
    },
  };
  const release = {
    coordinator,
    unconfirmed: false,
    close: async () => {
      assert.equal(f.timerActive, false, 'heartbeat must drain before coordinator cleanup');
      events.push('release-helper-close');
      return release.unconfirmed
        ? { cleaned: false, unconfirmed: true }
        : { cleaned: true, unconfirmed: false };
    },
  };
  const catalog = {
    unconfirmed: false,
    prepare: async () => {
      events.push('catalog-prepare');
      return { writes: 4, heads: [] };
    },
    close: async () => {
      assert.equal(f.timerActive, false);
      events.push('catalog-close');
      return { cleaned: true, unconfirmed: false };
    },
  };
  f.catalog = catalog;
  f.release = release;
  f.capture = (coordinator, collect = async () => ({ source: 'fresh' })) =>
    captureCatalogRegionalInput({
      coordinator,
      owner,
      config,
      now: time.now,
      createClient: async (guard, { withLease }) => {
        assert.equal(guard.ownerRunId, owner.ownerRunId);
        assert.equal(typeof withLease, 'function');
        events.push('catalog-create');
        return catalog;
      },
      collect,
      schedule: (callback) => {
        f.tick = callback;
        f.timerActive = true;
        return 'capture-timer';
      },
      cancel: (timer) => {
        assert.equal(timer, 'capture-timer');
        f.timerActive = false;
        events.push('heartbeat-stop');
      },
    });
  f.run = (prepare = (coordinator) => f.capture(coordinator)) =>
    withProductReleaseCoordinator({
      createClient: async () => {
        events.push('release-helper-create');
        return release;
      },
      prepare,
    });
  return f;
}

test('importing the normal snapshot entry does not execute the CLI or require live credentials', () => {
  assert.equal(typeof prepareProducts, 'function');
  assert.equal(typeof withProductReleaseCoordinator, 'function');
});

test('normal product capture drains its heartbeat and cleans catalog and lease before release helper', async (t) => {
  const f = await fixture(t);
  const result = await f.run(async (coordinator) => {
    assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
    return f.capture(coordinator, async ({ baseline, checkpoint }) => {
      assert.deepEqual(baseline, f.baseline);
      f.events.push('public-snapshot');
      await f.tick();
      await checkpoint();
      return { source: 'fresh', publicInput: 'snapshot' };
    });
  });
  assert.deepEqual(result.value, { source: 'fresh', publicInput: 'snapshot' });
  assert.equal(f.events.filter((x) => x === 'catalog-prepare').length, 2);
  assert.ok(f.events.indexOf('heartbeat-stop') < f.events.indexOf('catalog-close'));
  assert.ok(f.events.indexOf('catalog-close') < f.events.indexOf('release-complete'));
  assert.ok(f.events.indexOf('release-complete') < f.events.indexOf('release-helper-close'));
  const status = await f.actual.status();
  assert.equal(status.state, 'idle');
  assert.deepEqual(status.scope.baseline, f.baseline);
});

test('preflight failure cleans only the release helper and preserves the original failure', async (t) => {
  const f = await fixture(t);
  const error = Error('Runtime preflight rejected');
  await assert.rejects(
    f.run(async () => {
      throw error;
    }),
    (observed) => observed === error,
  );
  assert.deepEqual(f.events, ['release-helper-create', 'release-helper-close']);
  assert.equal((await f.actual.status()).state, 'idle');
});

test('known acquire rejection is covered even before capture starts its own try block', async (t) => {
  const f = await fixture(t);
  const error = Error('Acquire rejected before lease write');
  f.release.coordinator.acquire = async () => {
    f.events.push('acquire-rejected');
    throw error;
  };
  await assert.rejects(f.run(), (observed) => observed === error);
  assert.deepEqual(f.events, ['release-helper-create', 'acquire-rejected', 'release-helper-close']);
  assert.equal((await f.actual.status()).state, 'idle');
});

test('unknown acquire completion retains the acquired lease and the unknown release helper', async (t) => {
  const f = await fixture(t);
  const error = stopped('RELEASE_REGIONAL_UNCONFIRMED');
  f.release.coordinator.acquire = async (input) => {
    await f.actual.acquire(input);
    f.release.unconfirmed = true;
    f.events.push('acquire-reply-lost');
    throw error;
  };
  await assert.rejects(
    f.run(),
    (observed) =>
      observed.code === 'RELEASE_REGIONAL_UNCONFIRMED' &&
      observed.cause === error &&
      observed.errors[0] === error,
  );
  assert.equal((await f.actual.status()).state, 'leased');
  assert.ok(!f.events.includes('release-start'));
  assert.ok(!f.events.includes('catalog-create'));
  assert.equal(f.release.unconfirmed, true);
});

test('unknown catalog completion retains catalog and lease but still cleans the known release helper', async (t) => {
  const f = await fixture(t);
  const error = stopped('CATALOG_REGIONAL_UNCONFIRMED');
  f.catalog.prepare = async () => {
    f.catalog.unconfirmed = true;
    f.events.push('catalog-reply-lost');
    throw error;
  };
  await assert.rejects(f.run(), (observed) => observed === error);
  assert.equal((await f.actual.status()).state, 'leased');
  assert.ok(f.events.includes('heartbeat-stop'));
  assert.ok(!f.events.includes('catalog-close'));
  assert.ok(!f.events.includes('release-start'));
  assert.equal(f.events.at(-1), 'release-helper-close');
  assert.equal(f.release.unconfirmed, false);
});

test('unconfirmed catalog cleanup retains the lease before closing the known release helper', async (t) => {
  const f = await fixture(t);
  f.catalog.close = async () => {
    f.events.push('catalog-close-rejected');
    throw Error('Cannot confirm catalog deletion');
  };
  await assert.rejects(f.run(), { code: 'CATALOG_CAPTURE_CLEANUP_UNCONFIRMED' });
  assert.equal((await f.actual.status()).state, 'leased');
  assert.ok(!f.events.includes('release-start'));
  assert.equal(f.events.at(-1), 'release-helper-close');
});

test('public capture failure releases its known lease before closing the release helper', async (t) => {
  const f = await fixture(t);
  const error = Error('Public API failed');
  await assert.rejects(
    f.run((coordinator) =>
      f.capture(coordinator, async () => {
        throw error;
      }),
    ),
    (observed) => observed === error,
  );
  assert.equal((await f.actual.status()).state, 'idle');
  assert.ok(f.events.indexOf('release-complete') < f.events.indexOf('release-helper-close'));
});

test('a known read-only preparation without catalog capture still cleans the release helper', async (t) => {
  const f = await fixture(t);
  const result = await f.run(async (coordinator) => {
    const current = await coordinator.status({ scopeKey: 'site' });
    assert.deepEqual(current.scope.baseline, f.baseline);
    return { source: 'accepted' };
  });
  assert.deepEqual(result, { source: 'accepted' });
  assert.deepEqual(f.events, ['release-helper-create', 'release-helper-close']);
});

test('release cleanup uncertainty stops successful preparation', async (t) => {
  const f = await fixture(t);
  f.release.close = async () => ({ cleaned: false, unconfirmed: true });
  await assert.rejects(f.run(), { code: 'RELEASE_REGIONAL_UNCONFIRMED' });
  assert.equal((await f.actual.status()).state, 'idle');
});

test('release cleanup failure preserves both the preparation and cleanup errors', async (t) => {
  const f = await fixture(t);
  const original = Error('Runtime health unavailable');
  const cleanup = stopped('RELEASE_REGIONAL_UNCONFIRMED');
  f.release.close = async () => {
    throw cleanup;
  };
  await assert.rejects(
    f.run(async () => {
      throw original;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.code === 'RELEASE_REGIONAL_UNCONFIRMED' &&
      error.cause === original &&
      error.errors[0] === original &&
      error.errors[1] === cleanup,
  );
});

test('factory creation failure is returned without pretending a helper handle was acquired', async () => {
  const error = stopped('RELEASE_REGIONAL_UNCONFIRMED');
  let prepared = false;
  await assert.rejects(
    withProductReleaseCoordinator({
      createClient: async () => {
        throw error;
      },
      prepare: async () => {
        prepared = true;
      },
    }),
    (observed) => observed === error,
  );
  assert.equal(prepared, false);
});
