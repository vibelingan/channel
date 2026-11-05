import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration } from './release-hosting-fixtures.mjs';
import {
  clock,
  composition,
  policy as fixturePolicy,
  memoryStore,
  plan,
  receipt,
  stepInput,
} from './release-state-fixtures.mjs';
import { hostingBatchBeforeHash, hostingBatchHash } from './release/hosting-batches.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { recoverStoppedSiteDelivery } from './release/site-stopped-reconcile.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

const policy = {
  ...fixturePolicy,
  repository: 'vibelingan/channel',
  trustedRef: 'refs/heads/feat/seo-foundation',
  workflowPath: '.github/workflows/seo-static-canary.yml',
};
const runNumber = '41313740695';
const runId = `site-${runNumber}-1`;
const codeSha = 'c450903bb538915ace1fc01f7a1178376a308c40';
const runnerRef = `github:${policy.repository}:${runNumber}:attempt-1`;

async function fixture(t, { secondPath = 'products/second/index.html', memberCount = 2 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stopped-site-reconcile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const time = clock();
  const files = new Map([
    ['index.html', Buffer.from('<h1>Home</h1>')],
    ['products/first/index.html', Buffer.from('<h1>First product</h1>')],
    [secondPath, Buffer.from('<h1>Second product</h1>')],
  ]);
  for (let index = 2; index < memberCount; index++)
    files.set(`products/item-${index}/index.html`, Buffer.from(`<h1>Product ${index}</h1>`));
  const payloadDir = join(directory, 'payload');
  createSitePayload({
    directory: payloadDir,
    policy,
    configuration: configuration(),
    codeSha,
    releaseId: runId,
    files,
    snapshot: { siteOrigin: policy.siteOrigin },
    now: time.now(),
  });
  const input = siteArtifact({
    directory: payloadDir,
    policy,
    now: time.now(),
    run: {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      runId: runNumber,
      headSha: codeSha,
      artifact: {
        id: '123456',
        runId: runNumber,
        expiresAt: '2026-12-01T00:00:00Z',
        expired: false,
      },
    },
  });
  const store = memoryStore();
  const coordinator = createReleaseCoordinator({ store, policy, clock: time.now });
  const accepted = await coordinator.acquire({ ownerRunId: 'accepted', runnerRef: 'previous' });
  const parts = composition();
  parts.static.artifact.repository = policy.repository;
  await coordinator.startRun({
    guard: accepted,
    runId: 'accepted',
    scopeKey: 'site',
    kind: 'adopt',
    plan: plan(1),
    composition: parts,
  });
  const acceptance = await coordinator.beginStep({
    guard: accepted,
    runId: 'accepted',
    ...stepInput('accept'),
  });
  await coordinator.confirmStep({
    guard: accepted,
    runId: 'accepted',
    stepId: acceptance.stepId,
    receipt: receipt(acceptance),
  });
  await coordinator.commitRun({
    guard: accepted,
    runId: 'accepted',
    changeSetRef: 'fixture accepted',
  });
  const baseline = (await coordinator.status()).scope.baseline;
  const guard = await coordinator.acquire({ ownerRunId: runId, runnerRef });
  await coordinator.startRun({
    guard,
    runId,
    scopeKey: 'site',
    kind: 'publish',
    deliveredComponents: ['static'],
    plan: plan(4),
    composition: {
      static: {
        releaseId: runId,
        codeSha,
        contentSha256: plan(4).acceptanceHash,
        artifact: input.envelope.artifact,
      },
    },
  });
  const first = await coordinator.beginStep({ guard, runId, ...stepInput() });
  await coordinator.confirmStep({ guard, runId, stepId: first.stepId, receipt: receipt(first) });
  const members = input.staticManifest.entries
    .filter((entry) => entry.path !== 'index.html')
    .map((entry) => ({ ...entry, beforeHash: 'a'.repeat(64) }));
  const hash = hostingBatchHash(members);
  const step = await coordinator.beginStep({
    guard,
    runId,
    ...stepInput(),
    stepId: 'pending-html-batch',
    members,
    beforeHash: hostingBatchBeforeHash(members),
    afterHash: hash,
    subject: `upload-batch:${hash}`,
    verifySubject: `read-batch:${hash}`,
  });
  await coordinator.recordSubmitted({
    guard,
    runId,
    stepId: step.stepId,
    receipt: receipt(step, 'submitted'),
  });
  time.advance(180001);
  const job = {
    id: 123456789,
    run_id: Number(runNumber),
    name: 'site_delivery / site',
    head_sha: codeSha,
    status: 'completed',
    conclusion: 'failure',
    started_at: new Date(time.now() - 600000).toISOString(),
    completed_at: new Date(time.now() - 150000).toISOString(),
  };
  const githubRun = {
    id: Number(runNumber),
    run_attempt: 1,
    repository: { id: 1, full_name: policy.repository },
    head_repository: { id: 1, full_name: policy.repository },
    path: policy.workflowPath,
    head_branch: 'feat/seo-foundation',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'failure',
    head_sha: codeSha,
    updated_at: job.completed_at,
  };
  const f = {
    store,
    time,
    coordinator,
    baseline,
    guard,
    step,
    input,
    files,
    job,
    githubRun,
    requests: [],
    quietCalls: [],
    sourceFiles: new Map(),
    jobs: [job],
  };
  for (const path of [policy.workflowPath, '.github/workflows/seo-site-delivery.yml']) {
    f.sourceFiles.set(path, readFileSync(new URL(`../${path}`, import.meta.url)));
  }
  f.options = {
    coordinator,
    policy,
    runId,
    now: time.now,
    github: {
      api: async (path) => {
        if (path === `/actions/runs/${runNumber}/attempts/1`) return structuredClone(githubRun);
        if (path === `/actions/runs/${runNumber}/attempts/1/jobs?per_page=100&page=1`)
          return { total_count: f.jobs.length, jobs: structuredClone(f.jobs) };
        throw Error('Unexpected GitHub path');
      },
      get: async (path) => {
        const parsed = new URL(path, 'https://api.github.com');
        assert.equal(parsed.searchParams.get('ref'), codeSha);
        const filePath = parsed.pathname.replace(/^\/contents\//, '');
        const bytes = f.sourceFiles.get(filePath);
        assert.ok(bytes);
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              type: 'file',
              path: filePath,
              size: bytes.length,
              encoding: 'base64',
              content: bytes.toString('base64'),
            }),
          ),
        };
      },
    },
    loadCandidate: async ({ run, artifact }) => {
      assert.equal(run.runId, runId);
      assert.deepEqual(artifact, input.envelope.artifact);
      return input;
    },
    verifyQuiescence: async (context) => {
      f.quietCalls.push(context);
      return { ...context, checkedAt: time.now(), functionsAbsent: true, oldJobCompleted: true };
    },
    request: async (method, url, options) => {
      assert.equal(method, 'GET');
      assert.equal(new URL(url).origin, policy.siteOrigin);
      f.requests.push({ method, url, headers: options.headers });
      const path = new URL(url).pathname.slice(1).replace(/\/$/, '/index.html');
      const body = files.get(path);
      assert.ok(body);
      const etag = `"${path}"`;
      return {
        status: options.headers['if-none-match'] ? 304 : 200,
        headers: new Headers({ etag, 'cache-control': 'no-store', 'content-type': 'text/html' }),
        body: options.headers['if-none-match'] ? Buffer.alloc(0) : body,
      };
    },
  };
  return f;
}

async function refusesWithoutWrites(f, code = 'SITE_STOPPED_RECONCILE_UNPROVEN') {
  const before = f.store.inspect();
  const commits = f.store.commits;
  await assert.rejects(recoverStoppedSiteDelivery(f.options), { code });
  assert.deepEqual(f.store.inspect(), before);
  assert.equal(f.store.commits, commits);
}

test('an ended writer with exact HTML and three cache modes releases only ledger state and preserves dirty candidate', async (t) => {
  const f = await fixture(t);
  const commits = f.store.commits;
  const result = await recoverStoppedSiteDelivery(f.options);
  assert.deepEqual(result, {
    status: 'reconciled',
    runId,
    observedHash: f.step.afterHash,
    verifiedUrls: 2,
    websiteWrites: 0,
    businessWrites: 0,
    recoveryRequired: true,
  });
  const status = await f.coordinator.status();
  assert.equal(status.state, 'recovery-required');
  assert.equal(status.target.dirtyRunId, runId);
  assert.equal(status.target.lease, null);
  assert.equal(status.target.currentRunId, null);
  assert.equal(status.target.unresolvedOperation, null);
  assert.deepEqual(status.scope.baseline, f.baseline);
  const run = await f.coordinator.runStatus(runId);
  assert.equal(run.state, 'FAILED');
  assert.equal(run.accepted, null);
  assert.equal(run.verifiedWrites, 1);
  assert.equal(run.verifiedSteps, 1);
  assert.equal(f.store.commits, commits + 1);
  assert.equal(f.requests.length, 6);
  assert.equal(f.quietCalls.length, 2);
  for (const path of ['/products/first/', '/products/second/']) {
    const requests = f.requests.filter((request) => new URL(request.url).pathname === path);
    assert.deepEqual(
      requests.map((request) => [
        request.headers['cache-control'],
        Boolean(request.headers['if-none-match']),
      ]),
      [
        [undefined, false],
        ['no-cache', false],
        ['no-cache', true],
      ],
    );
  }
});

test('unknown pending write uses the same exact readback rather than replaying upload', async (t) => {
  const f = await fixture(t);
  const record = f.store
    .inspect()
    .find(([key, value]) => key.startsWith('steps/') && value.stepId === f.step.stepId);
  f.store.replace('steps', record[0].slice('steps/'.length), { ...record[1], state: 'unknown' });
  assert.equal((await recoverStoppedSiteDelivery(f.options)).status, 'reconciled');
});

test('wrong repository source run attempt or unfinished job cannot release a writer', async (t) => {
  const mutations = [
    (f) => {
      f.githubRun.repository.full_name = 'other/channel';
    },
    (f) => {
      f.githubRun.head_repository.id = 2;
    },
    (f) => {
      f.githubRun.run_attempt = 2;
    },
    (f) => {
      f.githubRun.head_branch = 'main';
    },
    (f) => {
      f.githubRun.path = '.github/workflows/deploy-test.yml';
    },
    (f) => {
      f.githubRun.event = 'push';
    },
    (f) => {
      f.githubRun.head_sha = 'a'.repeat(40);
    },
    (f) => {
      f.githubRun.status = 'in_progress';
    },
    (f) => {
      f.job.name = 'other / site';
    },
    (f) => {
      f.job.status = 'in_progress';
    },
    (f) => {
      f.job.conclusion = 'skipped';
    },
    (f) => {
      f.job.head_sha = 'a'.repeat(40);
    },
    (f) => {
      f.jobs.push({ ...f.job, id: 100, name: 'other', status: 'in_progress' });
    },
    (f) => {
      f.jobs.push({ ...f.job });
    },
    (f) => {
      f.job.completed_at = new Date(f.time.now() - 119999).toISOString();
    },
    (f) => {
      f.time.advance(-180001);
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    mutate(f);
    await refusesWithoutWrites(f);
  }
});

test('both workflow files must retain the reviewed branch environment and execution entry', async (t) => {
  const mutations = [
    (f) =>
      f.sourceFiles.set(
        policy.workflowPath,
        Buffer.from(
          f.sourceFiles
            .get(policy.workflowPath)
            .toString()
            .replace(
              'uses: ./.github/workflows/seo-site-delivery.yml',
              'uses: other/repo/workflow@main',
            ),
        ),
      ),
    (f) =>
      f.sourceFiles.set(
        '.github/workflows/seo-site-delivery.yml',
        Buffer.from(
          f.sourceFiles
            .get('.github/workflows/seo-site-delivery.yml')
            .toString()
            .replace('environment: test', 'environment: production'),
        ),
      ),
    (f) =>
      f.sourceFiles.set(
        '.github/workflows/seo-site-delivery.yml',
        Buffer.from(
          f.sourceFiles
            .get('.github/workflows/seo-site-delivery.yml')
            .toString()
            .replace('scripts/run-site-delivery.ts', 'scripts/other.ts'),
        ),
      ),
    (f) =>
      f.sourceFiles.set(
        '.github/workflows/seo-site-delivery.yml',
        Buffer.from(
          f.sourceFiles
            .get('.github/workflows/seo-site-delivery.yml')
            .toString()
            .replace("ref: '${{ github.sha }}'", "ref: 'main'"),
        ),
      ),
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    mutate(f);
    await refusesWithoutWrites(f);
  }
});

test('an arbitrary boolean or incomplete stale cross-run quiescence record is refused', async (t) => {
  for (const mutate of [
    () => true,
    (context) => ({ ...context, functionsAbsent: false, oldJobCompleted: true, checkedAt: 0 }),
    (context) => ({ ...context, functionsAbsent: true, oldJobCompleted: false, checkedAt: 0 }),
    (context, now) => ({
      ...context,
      runId: 'other',
      functionsAbsent: true,
      oldJobCompleted: true,
      checkedAt: now,
    }),
    (context, now) => ({
      ...context,
      functionsAbsent: true,
      oldJobCompleted: true,
      checkedAt: now - 60001,
    }),
  ]) {
    const f = await fixture(t);
    f.options.verifyQuiescence = async (context) => mutate(context, f.time.now());
    await refusesWithoutWrites(f);
  }
});

test('non HTML batches are deliberately outside this recovery entry', async (t) => {
  const f = await fixture(t, { secondPath: 'assets/site.js' });
  await refusesWithoutWrites(f);
  assert.equal(f.requests.length, 0);
});

test('candidate metadata or file corruption cannot authorize clearing the pending operation', async (t) => {
  for (const mutate of [
    (f) => {
      f.input.envelope.releaseId = 'other';
    },
    (f) => {
      f.input.acceptedSeal = { fake: true };
    },
    (f) => {
      f.input.policy.ref = 'refs/heads/main';
    },
    (f) => {
      f.options.loadCandidate = async () => ({ ...f.input, directory: '/missing-candidate' });
    },
    (f) => {
      writeFileSync(
        join(f.input.directory, 'products/first/index.html'),
        'corrupt local candidate',
      );
    },
  ]) {
    const f = await fixture(t);
    // Real artifact values are frozen; clone only the injected input for negative cases.
    f.input = structuredClone({ ...f.input });
    f.options.loadCandidate = async () => f.input;
    mutate(f);
    await refusesWithoutWrites(f);
  }
});

test('wrong body stale caches or conditional ETag mismatch leave all records untouched', async (t) => {
  for (const mode of ['body', 'ordinary-cache', 'etag']) {
    const f = await fixture(t);
    const original = f.options.request;
    f.options.request = async (method, url, options) => {
      const response = await original(method, url, options);
      if (mode === 'body' && !options.headers['if-none-match'])
        response.body = Buffer.from('changed');
      if (mode === 'ordinary-cache' && !options.headers['cache-control'])
        response.headers.set('cache-control', 'public,max-age=600');
      if (mode === 'etag' && options.headers['if-none-match'])
        response.headers.set('etag', '"different"');
      return response;
    };
    await refusesWithoutWrites(f);
  }
});

test('quiescence is required again after the complete HTTP readback', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const original = f.options.verifyQuiescence;
  f.options.verifyQuiescence = async (context) => {
    const result = await original(context);
    return ++calls === 1 ? result : { ...result, functionsAbsent: false };
  };
  await refusesWithoutWrites(f);
  assert.equal(f.requests.length, 6);
});

test('a concurrent target change is caught before reconcile without overwriting that change', async (t) => {
  const f = await fixture(t);
  const original = f.options.verifyQuiescence;
  let calls = 0;
  f.options.verifyQuiescence = async (context) => {
    const result = await original(context);
    if (++calls === 2) {
      const [key, target] = f.store.inspect().find(([key]) => key.startsWith('targets/'));
      f.store.replace('targets', key.slice('targets/'.length), {
        ...target,
        version: target.version + 1,
      });
    }
    return result;
  };
  const commits = f.store.commits;
  await assert.rejects(recoverStoppedSiteDelivery(f.options), {
    code: 'SITE_STOPPED_RECONCILE_CHANGED',
  });
  assert.equal(f.store.commits, commits);
  assert.equal((await f.coordinator.status()).target.currentRunId, runId);
});

test('lost reconcile acknowledgement requires readback and never blindly retries', async (t) => {
  const f = await fixture(t);
  const original = f.options.verifyQuiescence;
  let calls = 0;
  f.options.verifyQuiescence = async (context) => {
    const result = await original(context);
    if (++calls === 2) f.store.loseNextAck();
    return result;
  };
  const commits = f.store.commits;
  await assert.rejects(recoverStoppedSiteDelivery(f.options), {
    code: 'SITE_STOPPED_RECONCILE_NEEDS_READBACK',
  });
  assert.equal(f.store.commits, commits + 1);
  assert.equal((await f.coordinator.status()).state, 'recovery-required');
  assert.equal((await f.coordinator.runStatus(runId)).state, 'FAILED');
});

test('unexpected SDK errors never expose messages signed URLs or credentials', async (t) => {
  const f = await fixture(t);
  f.options.verifyQuiescence = async () => {
    throw Error('https://secret.example/?token=do-not-copy');
  };
  await assert.rejects(
    recoverStoppedSiteDelivery(f.options),
    (error) => error.code === 'SITE_STOPPED_RECONCILE_UNPROVEN' && error.message === error.code,
  );
});

test('a complete twelve-file pending batch checks all thirty-six cache responses', async (t) => {
  const f = await fixture(t, { memberCount: 12 });
  const result = await recoverStoppedSiteDelivery(f.options);
  assert.equal(result.verifiedUrls, 12);
  assert.equal(f.requests.length, 36);
});

test('a second manual call cannot reconcile an already released run again', async (t) => {
  const f = await fixture(t);
  await recoverStoppedSiteDelivery(f.options);
  await refusesWithoutWrites(f);
});

test('diagnostics retain only the fixed stage and safe underlying SDK code', async (t) => {
  const f = await fixture(t);
  f.options.verifyQuiescence = async () => {
    throw Object.assign(Error('https://secret.example/?token=private'), {
      code: 'ResourceUnavailable.TransactionNotExist',
    });
  };
  await assert.rejects(recoverStoppedSiteDelivery(f.options), (error) => {
    assert.equal(error.code, 'SITE_STOPPED_RECONCILE_UNPROVEN');
    assert.equal(error.message, error.code);
    assert.equal(error.reconcileStage, 'quiescence-before');
    assert.equal(error.underlyingCode, 'ResourceUnavailable.TransactionNotExist');
    assert.equal(JSON.stringify(error).includes('private'), false);
    return true;
  });
  f.options.verifyQuiescence = async () => {
    throw Object.assign(Error('private'), { code: 'token=private' });
  };
  await assert.rejects(
    recoverStoppedSiteDelivery(f.options),
    (error) => !Object.hasOwn(error, 'underlyingCode'),
  );
});
