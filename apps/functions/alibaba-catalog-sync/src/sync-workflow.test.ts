import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_ALIBABA_ENDPOINTS,
  createAlibabaClient,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { acquireAlibabaSyncLease, setAdapter } from '@vibelingan-channel/db';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { handleAlibabaSyncRequest } from './handler.ts';
import type { RunnerDeps } from './runner.ts';
import {
  initialSyncPreparation,
  resumeSyncWorkflow,
  startSyncWorkflow,
  syncWorkflowStatus,
} from './sync-workflow.ts';
const at = '2026-10-21T00:00:00.000Z';
async function fixture(t: TestContext, preparation = false) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-sync-workflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.json');
  await writeFile(
    file,
    JSON.stringify({
      alibabaSyncCheckpoints: [
        { _id: 'primary', activeRunId: '', committedCursor: at, nextIncrementalDueAt: at },
      ],
      alibabaSyncRuns: preparation
        ? [
            {
              _id: 'run',
              status: 'completed',
              startedAt: at,
              preparationPending: true,
              preparation: initialSyncPreparation(at),
              counters: { itemsProcessed: 3 },
            },
          ]
        : [],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  let providerCalls = 0;
  let now = at;
  const runner: RunnerDeps = {
    client: createAlibabaClient({
      appKey: 'test-key',
      appSecret: 'test-secret',
      endpoints: DEFAULT_ALIBABA_ENDPOINTS,
      fetchImpl: async () => {
        providerCalls++;
        throw Error('Supplier transport should not run');
      },
    }),
    getAccessToken: async () => ({ ok: true, accessToken: 'local-test-token' }),
    now: () => now,
    alert: async () => {},
  };
  return {
    directory: dir,
    adapter,
    runner,
    providerCalls: () => providerCalls,
    setNow: (value: string) => {
      now = value;
    },
  };
}
const noPhotoIssues = async () => ({ hiddenDrafts: 0, draftsToFill: 0, draftsMissingPhotos: 0 });
const photoPage = (
  extra: Partial<
    Awaited<ReturnType<typeof import('./photo-preparation.ts').prepareAlibabaPhotosPage>>
  > = {},
) => ({
  afterProductId: '',
  nextProductId: 'tail',
  done: true,
  visited: 3,
  prepared: 3,
  photosCopied: 4,
  photosReused: 2,
  photosFailed: 0,
  busy: 0,
  waiting: 0,
  failures: [],
  ...extra,
});
test('one click persists the source checkpoint with zero supplier API calls; duplicate click reuses it', async (t) => {
  const h = await fixture(t);
  const first = await startSyncWorkflow(h.runner, true);
  assert.ok(first.runId);
  assert.equal(h.providerCalls(), 0);
  const second = await startSyncWorkflow(h.runner, true);
  assert.equal(second.runId, first.runId);
  const runs = await h.adapter.list({
    collection: 'alibabaSyncRuns',
    page: 1,
    pageSize: 20,
    search: '',
  });
  assert.equal(runs.items.length, 1);
});
test('timer does not start a new run just because old schedule watermarks are due', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await resumeSyncWorkflow({ enabled: true, runner: h.runner }), {
    outcome: 'idle',
  });
  assert.equal(h.providerCalls(), 0);
  assert.equal(
    (await h.adapter.list({ collection: 'alibabaSyncRuns', page: 1, pageSize: 20, search: '' }))
      .items.length,
    0,
  );
});
test('background execution continues the existing run without browser or app JWT', async (t) => {
  const h = await fixture(t);
  const start = await startSyncWorkflow(h.runner, true);
  let calls = 0;
  const result = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    tick: async (input) => {
      calls++;
      assert.equal(input.trigger, 'timer');
      assert.equal(input.budgetOverrides?.softDeadlineMs, 45000);
      return { outcome: 'continued', ...(start.runId ? { runId: start.runId } : {}) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.runId, start.runId);
});
test('completed source photos finish durably and an idle duplicate timer never repeats them', async (t) => {
  const h = await fixture(t, true);
  let calls = 0;
  const deps = {
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => {
      calls++;
      return photoPage();
    },
  };
  assert.equal((await resumeSyncWorkflow(deps)).outcome, 'complete');
  assert.equal((await resumeSyncWorkflow(deps)).outcome, 'idle');
  assert.equal(calls, 1);
  const status = await syncWorkflowStatus(true, at);
  assert.equal(status.phase, 'complete');
  assert.equal(status.photosCopied, 4);
  assert.equal(status.history[0]?.result, 'complete');
});
test('duplicate timers admit one photo worker under the real repository lease', async (t) => {
  const h = await fixture(t, true);
  let calls = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => {
      calls++;
      await barrier;
      return photoPage();
    },
  });
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 2));
  const other = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => {
      calls++;
      return photoPage();
    },
  });
  release();
  await first;
  assert.equal(other.outcome, 'lease-busy');
  assert.equal(calls, 1);
});
test('lost photo response keeps the original durable cursor for safe idempotent resume', async (t) => {
  const h = await fixture(t, true);
  assert.equal(
    (
      await resumeSyncWorkflow({
        enabled: true,
        runner: h.runner,
        photoStatus: noPhotoIssues,
        photos: async () => {
          throw Error('reply lost');
        },
      })
    ).outcome,
    'waiting',
  );
  const row = await h.adapter.get('alibabaSyncRuns', 'run');
  assert.equal(row?.preparationPending, true);
  assert.equal((row?.preparation as { cursor: string }).cursor, '');
  h.setNow('2026-10-21T00:02:00.000Z');
  let cursor = '';
  await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async (input) => {
      cursor = input?.afterProductId ?? '';
      return photoPage();
    },
  });
  assert.equal(cursor, '');
});
test('stale worker cannot advance cursor after lease expiry and takeover', async (t) => {
  const h = await fixture(t, true);
  const result = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => {
      h.setNow('2026-10-21T00:04:00.000Z');
      const grant = await acquireAlibabaSyncLease('primary', 'replacement', h.runner.now(), 180000);
      assert.equal(grant.result, 'granted');
      return photoPage();
    },
  });
  assert.equal(result.outcome, 'lease-lost');
  const row = await h.adapter.get('alibabaSyncRuns', 'run');
  assert.deepEqual(row?.preparation, initialSyncPreparation(at));
});
test('transient photo failures wait for a server retry rather than report completion', async (t) => {
  const h = await fixture(t, true);
  const result = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => photoPage({ waiting: 1 }),
  });
  assert.equal(result.outcome, 'waiting');
  const next = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async () => {
      throw Error('early retry');
    },
  });
  assert.equal(next.outcome, 'waiting');
  const status = await syncWorkflowStatus(true, at);
  assert.equal(status.phase, 'waiting');
  assert.ok(status.nextRetryAt);
});
test('permanent preparation errors remain visible, not false success', async (t) => {
  const h = await fixture(t, true);
  await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photos: async () => photoPage({ photosFailed: 1 }),
    photoStatus: async () => ({ hiddenDrafts: 0, draftsToFill: 0, draftsMissingPhotos: 1 }),
  });
  const status = await syncWorkflowStatus(true, at);
  assert.equal(status.phase, 'attention');
  assert.equal(status.issue, 'photos');
  assert.equal(status.photoIssues, 1);
  assert.equal(status.history[0]?.result, 'attention');
});
test('disabled background rejects new start and runs no timer work', async (t) => {
  const h = await fixture(t);
  await assert.rejects(startSyncWorkflow(h.runner, false), /not available/);
  assert.equal(
    (await resumeSyncWorkflow({ enabled: false, runner: h.runner })).outcome,
    'disabled',
  );
  assert.equal(h.providerCalls(), 0);
});
test('workflow status is read-only and does not expose supplier secrets or native checkpoints', async (t) => {
  const h = await fixture(t);
  const before = await h.adapter.get('alibabaSyncCheckpoints', 'primary');
  const result = await syncWorkflowStatus(true, at);
  assert.equal(result.phase, 'idle');
  assert.deepEqual(await h.adapter.get('alibabaSyncCheckpoints', 'primary'), before);
  assert.equal(h.providerCalls(), 0);
  for (const word of ['test-secret', 'local-test-token', 'enumerationState', 'fence'])
    assert.equal(JSON.stringify(result).includes(word), false);
});

test('three transport failures stop automatically with a visible recovery state', async (t) => {
  const h = await fixture(t, true);
  for (let n = 0; n < 3; n++) {
    h.setNow(`2026-10-21T00:0${n * 2}:00.000Z`);
    const result = await resumeSyncWorkflow({
      enabled: true,
      runner: h.runner,
      photos: async () => {
        throw Error('supplier transport');
      },
    });
    assert.equal(result.outcome, n === 2 ? 'attention' : 'waiting');
  }
  const status = await syncWorkflowStatus(true, h.runner.now());
  assert.equal(status.phase, 'attention');
  assert.equal(status.issue, 'preparation');
  assert.equal((await resumeSyncWorkflow({ enabled: true, runner: h.runner })).outcome, 'idle');
});
test('transport retry keeps a later photo cursor instead of restarting its prefix', async (t) => {
  const h = await fixture(t, true);
  const preparation = initialSyncPreparation(at);
  preparation.cursor = 'original-cursor';
  await h.adapter.update('alibabaSyncRuns', 'run', { preparation });
  await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photos: async () => {
      throw Error('lost');
    },
  });
  h.setNow('2026-10-21T00:02:00.000Z');
  let cursor = '';
  await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    photoStatus: noPhotoIssues,
    photos: async (input) => {
      cursor = input?.afterProductId ?? '';
      return photoPage();
    },
  });
  assert.equal(cursor, 'original-cursor');
});
test('transport retry resumes the draft phase and cannot silently skip to photos', async (t) => {
  const h = await fixture(t, true);
  const preparation = initialSyncPreparation(at);
  preparation.phase = 'drafts';
  preparation.resumePhase = 'drafts';
  preparation.cursor = 'source-cursor';
  await h.adapter.update('alibabaSyncRuns', 'run', { preparation });
  await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    drafts: async () => {
      throw Error('lost draft response');
    },
  });
  h.setNow('2026-10-21T00:02:00.000Z');
  let cursor = '';
  const result = await resumeSyncWorkflow({
    enabled: true,
    runner: h.runner,
    drafts: async (input) => {
      cursor = input.afterSourceKey ?? '';
      throw Error('stop after verifying cursor');
    },
  });
  assert.equal(cursor, 'source-cursor');
  assert.equal(result.outcome, 'waiting');
});
test('invalid saved preparation is retained for diagnosis and cannot monopolize the background queue', async (t) => {
  const h = await fixture(t, true);
  await h.adapter.update('alibabaSyncRuns', 'run', { preparation: { phase: 'corrupt' } });
  assert.equal(
    (await resumeSyncWorkflow({ enabled: true, runner: h.runner })).outcome,
    'invalid-preparation',
  );
  const row = await h.adapter.get('alibabaSyncRuns', 'run');
  assert.deepEqual(row?.preparation, { phase: 'corrupt' });
  assert.equal(row?.preparationPending, false);
  assert.equal((await syncWorkflowStatus(true, at)).phase, 'attention');
});
test('new workflow routes enforce the live administrator before reading or starting any sync', async (t) => {
  const h = await fixture(t);
  const secret = 'workflow-auth-local-only';
  await h.adapter.createDocWithId('users', 'contributor', {
    role: 'contributor',
    status: 'active',
  });
  const token = await signSession(secret, {
    sub: 'contributor',
    role: 'contributor',
    name: 'Test',
    email: 'test@example.test',
  });
  for (const action of ['workflowStatus', 'startSync']) {
    const anonymous = await handleAlibabaSyncRequest(
      { action },
      { jwtSecret: secret, backgroundSyncEnabled: true },
    );
    assert.equal(anonymous.ok, false);
    const denied = await handleAlibabaSyncRequest(
      { action, token },
      { jwtSecret: secret, backgroundSyncEnabled: true },
    );
    assert.equal(denied.ok, false);
  }
  assert.equal(h.providerCalls(), 0);
  assert.equal(
    (await h.adapter.list({ collection: 'alibabaSyncRuns', page: 1, pageSize: 20, search: '' }))
      .items.length,
    0,
  );
});

test('completion rechecks current lease time after its final delayed read', async (t) => {
  const h = await fixture(t);
  setMediaStorage(new LocalDiskMediaStorage(join(h.directory, 'media')));
  const runner = {
    ...h.runner,
    client: createAlibabaClient({
      appKey: 'test-key',
      appSecret: 'test-secret',
      endpoints: DEFAULT_ALIBABA_ENDPOINTS,
      fetchImpl: async () =>
        new Response(JSON.stringify({ result: { total_item: 0, products: [] } })),
    }),
  };
  const started = await startSyncWorkflow(runner, true);
  assert.ok(started.runId);
  const get = h.adapter.get.bind(h.adapter);
  let delayed = false;
  h.adapter.get = async (collection, id) => {
    const value = await get(collection, id);
    if (!delayed && collection === 'alibabaSyncRuns' && value?.draftPreparationRequired === false) {
      delayed = true;
      h.setNow('2026-10-21T00:04:00.000Z');
    }
    return value;
  };
  await resumeSyncWorkflow({ enabled: true, runner });
  assert.equal(delayed, true);
  const row = await get('alibabaSyncRuns', started.runId);
  assert.notEqual(
    row?.status,
    'completed',
    'an expired holder cannot commit a terminal run with its earlier timestamp',
  );
});

test('one click heals a terminal checkpoint then enqueues a new run without supplier calls', async (t) => {
  const h = await fixture(t);
  await h.adapter.createDocWithId('alibabaSyncRuns', 'old', {
    status: 'failed',
    startedAt: at,
    mode: 'incremental',
  });
  await h.adapter.update('alibabaSyncCheckpoints', 'primary', { activeRunId: 'old' });
  const started = await startSyncWorkflow(h.runner, true);
  assert.ok(started.runId);
  assert.notEqual(started.runId, 'old');
  assert.equal(h.providerCalls(), 0);
  assert.ok(['syncing', 'queued'].includes(started.phase));
});
