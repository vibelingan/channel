import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import {
  captureReadbackCatalog,
  clearReadbackCatalogRegistration,
  createReadbackRegionalAccess,
  runSiteReadback,
} from './run-site-readback.mjs';

const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { createCatalogAcceptanceProof } = tsxRequire('./catalog-acceptance.ts', import.meta.url);
const { catalogPublicRecordId } = tsxRequire(
  '../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const runId = 'site-41300590230-1';
const owner = {
  ownerRunId: 'readback-41303614689-1',
  runnerRef: 'github:vibelingan/channel:41303614689:attempt-1',
};
const guard = {
  targetId: 'b'.repeat(64),
  ownerRunId: owner.ownerRunId,
  fence: 7,
  acquiredVersion: 9,
};
const codeSha = 'a'.repeat(40);
function catalogFixture() {
  const config = { siteOrigin: policy.siteOrigin, detailEnabled: true };
  const heads = ['p1', 'p2'].map((productId) => ({
    _id: catalogPublicRecordId(policy.siteOrigin, productId),
    schemaVersion: 1,
    siteOrigin: policy.siteOrigin,
    productId,
    sequence: 2,
    visible: true,
    semanticHash: 'c'.repeat(64),
    detailRevision: null,
    changedAt: '2026-11-01T00:00:00.000Z',
    latestEventId: 'd'.repeat(64),
  }));
  const snapshot = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin: policy.siteOrigin,
      products: heads.map((head) => ({
        product: { _id: head.productId, name: `Current ${head.productId}` },
        publicVersion: { sequence: 2, semanticHash: head.semanticHash, changedAt: head.changedAt },
      })),
    }),
  );
  const capture = { writes: 7, heads, delivery: { check: async () => {} } };
  const proof = createCatalogAcceptanceProof({ config, capture, snapshot });
  return { config, capture, proof, snapshot };
}
function acceptedFixture() {
  const artifact = { repository: 'vibelingan/channel', runId: '41300590230', artifactId: '123456' };
  const acceptedSeal = { schemaVersion: 1, manifestSha256: 'e'.repeat(64) };
  const acceptedRun = {
    state: 'SUCCEEDED',
    runId,
    composition: { static: { artifact } },
    accepted: { sourceRunId: runId, seals: { static: acceptedSeal } },
  };
  const input = {
    envelope: { artifact },
    acceptedSeal,
    privateFiles: ['must-not-be-sent'],
    credentials: { mustNotBeSent: true },
  };
  return { artifact, acceptedSeal, acceptedRun, input };
}

test('importing readback helpers does not execute the operational CLI', async () => {
  await assert.rejects(
    runSiteReadback({}),
    /Pinned manual read-only acceptance invocation required/,
  );
});

test('readback preserves the original task identity while updating only its new runner guard', async () => {
  const creations = [];
  const updates = [];
  const canceled = [];
  let checkpoints = 0;
  const client = {
    setGuard: (value) => updates.push(value),
    close: async () => ({ cleaned: true }),
  };
  const access = createReadbackRegionalAccess({
    manager: {},
    runId,
    codeSha,
    owner,
    directory: '/private/readback/regional',
    createClient: async (value) => {
      creations.push(value);
      return client;
    },
    schedule: (_callback, interval) => {
      assert.equal(interval, 30_000);
      return 'timer';
    },
    cancel: (timer) => canceled.push(timer),
  });
  const checkpoint = async () => {
    checkpoints++;
  };
  assert.equal(await access.use(guard, checkpoint), client);
  const next = { ...guard, fence: 8, acquiredVersion: 10 };
  assert.equal(await access.use(next, checkpoint), client);
  assert.equal(creations.length, 1);
  assert.equal(creations[0].runId, 'site-41300590230-1');
  assert.equal(creations[0].ownerRunId, 'readback-41303614689-1');
  assert.equal(creations[0].runnerRef, 'github:vibelingan/channel:41303614689:attempt-1');
  assert.deepEqual(updates, [next]);
  assert.equal(checkpoints, 2);
  assert.deepEqual(canceled, ['timer']);
  await assert.rejects(access.use({ ...guard, ownerRunId: runId }), /another owner/);
  assert.deepEqual(await access.close(), { cleaned: true });
  assert.deepEqual(canceled, ['timer', 'timer']);
});

test('loss of the readback lease during worker creation prevents its use and drains renewal', async () => {
  let tick;
  let resolveCreation;
  let creationStarted;
  const started = new Promise((resolve) => {
    creationStarted = resolve;
  });
  let checkpoints = 0;
  let closed = false;
  let canceled = false;
  let elapsed = 0;
  const access = createReadbackRegionalAccess({
    manager: {},
    runId,
    codeSha,
    owner,
    directory: '/private/readback/regional',
    now: () => elapsed,
    createClient: async () => {
      creationStarted();
      return new Promise((resolve) => {
        resolveCreation = resolve;
      });
    },
    schedule: (callback) => {
      tick = callback;
      return 'timer';
    },
    cancel: () => {
      canceled = true;
    },
  });
  const pending = access.use(guard, async () => {
    if (++checkpoints > 1) throw Error('Readback lease lost');
  });
  await started;
  elapsed += 30_000;
  await tick();
  resolveCreation({
    close: async () => {
      closed = true;
      return { cleaned: true };
    },
  });
  await assert.rejects(pending, /Readback lease lost/);
  assert.equal(canceled, true);
  await access.close();
  assert.equal(closed, true);
});

test('capture verifies the original sealed inputs without consuming pending requests', async () => {
  const f = catalogFixture();
  let captures = 0;
  let checkpoints = 0;
  const regional = {
    capture: async (config) => {
      assert.deepEqual(config, f.config);
      captures++;
      return f.capture;
    },
    prepare: async () => {
      throw Error('Readback must not consume pending requests');
    },
  };
  const current = await captureReadbackCatalog({
    regional,
    proof: f.proof,
    snapshot: f.snapshot,
    checkpoint: async () => {
      checkpoints++;
    },
  });
  assert.equal(current, f.capture);
  assert.equal(captures, 1);
  assert.equal(checkpoints, 2);
  await assert.rejects(
    captureReadbackCatalog({
      regional: { ...regional, capture: async () => ({ ...f.capture, writes: 8 }) },
      proof: f.proof,
      snapshot: f.snapshot,
    }),
    /Products changed after delivery/,
  );
  const pending = Object.assign(Error('New pending changes exist'), {
    code: 'STOP_CATALOG_CHANGE',
  });
  await assert.rejects(
    captureReadbackCatalog({
      regional: {
        ...regional,
        capture: async () => {
          throw pending;
        },
      },
      proof: f.proof,
      snapshot: f.snapshot,
    }),
    (error) => error === pending,
  );
});

test('readback cleanup sends exact accepted identity only and renews a long paginated cleanup', async () => {
  const f = acceptedFixture();
  const checks = [];
  let clock = 0;
  let command;
  const result = await clearReadbackCatalogRegistration({
    ...f,
    regional: {
      clearAcceptedRegistration: async ({ checkpoint, ...input }) => {
        command = input;
        for (clock of [0, 29_999, 30_000, 59_999, 60_000]) await checkpoint();
        return { releasedTasks: 528, controlReleased: true };
      },
    },
    checkpoint: async () => {
      checks.push(clock);
    },
    now: () => clock,
  });
  assert.deepEqual(command, { artifact: f.artifact, acceptedSeal: f.acceptedSeal });
  assert.deepEqual(checks, [0, 30_000, 60_000, 60_000]);
  assert.deepEqual(result, { releasedTasks: 528, controlReleased: true });
});

test('wrong accepted source or an unconfirmed regional cleanup cannot be treated as restored', async () => {
  const f = acceptedFixture();
  let calls = 0;
  const regional = {
    clearAcceptedRegistration: async () => {
      calls++;
    },
  };
  for (const acceptedRun of [
    { ...f.acceptedRun, state: 'RUNNING' },
    { ...f.acceptedRun, accepted: { ...f.acceptedRun.accepted, sourceRunId: 'other-site' } },
    {
      ...f.acceptedRun,
      composition: { static: { artifact: { ...f.artifact, artifactId: 'other' } } },
    },
    {
      ...f.acceptedRun,
      accepted: { ...f.acceptedRun.accepted, seals: { static: { different: true } } },
    },
  ])
    await assert.rejects(clearReadbackCatalogRegistration({ ...f, acceptedRun, regional }));
  assert.equal(calls, 0);
  const unknown = Object.assign(Error('Regional result unconfirmed'), {
    code: 'CATALOG_REGIONAL_UNCONFIRMED',
  });
  await assert.rejects(
    clearReadbackCatalogRegistration({
      ...f,
      regional: {
        clearAcceptedRegistration: async () => {
          throw unknown;
        },
      },
    }),
    (error) => error === unknown,
  );
});

test('readback keeps the current guard alive through regional work and drains before release', async () => {
  let elapsed = 0;
  let tick;
  let active = false;
  let wrapper;
  let renewals = 0;
  let expiresAt = 0;
  let canceled = false;
  const access = createReadbackRegionalAccess({
    manager: {},
    runId,
    codeSha,
    owner,
    directory: '/private/readback/regional',
    now: () => elapsed,
    schedule: (callback) => {
      tick = callback;
      return 'timer';
    },
    cancel: () => {
      canceled = true;
    },
    createClient: async (options) => {
      wrapper = options.withLease;
      return { close: async () => ({ cleaned: true }) };
    },
  });
  await access.use(guard, async () => {
    assert.equal(active, false);
    renewals++;
    expiresAt = elapsed + 180_000;
  });
  for (let n = 0; n < 40; n++)
    await wrapper(async () => {
      active = true;
      try {
        elapsed += 6_000;
        await tick();
        assert.ok(expiresAt > elapsed);
      } finally {
        active = false;
      }
    });
  assert.equal(renewals, 8);
  // The timer also protects the lease while no regional call is running (e.g. browser checks).
  elapsed += 30_000;
  await tick();
  assert.equal(renewals, 9);
  await access.drain();
  assert.equal(canceled, true);
  await assert.rejects(
    wrapper(async () => assert.fail('Operation after release boundary')),
    { code: 'LEASE_HEARTBEAT_STOPPED' },
  );
  await access.close();
});
