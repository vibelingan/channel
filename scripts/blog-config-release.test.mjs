import assert from 'node:assert/strict';
import test from 'node:test';
import { blogConfigRelease } from './blog/config-release.mjs';
import { waitForBlogIndexing } from './blog/indexing-convergence.mjs';
const sha = 'a'.repeat(40);
function task() {
  return {
    data: {
      envId: 'env',
      serverName: 'blog-pages',
      latestDeployStatus: 'normal',
      task: {
        Id: 12,
        EnvId: 'env',
        ServerName: 'blog-pages',
        Status: 'finished',
        ChangeType: 'CONFIG',
        VersionName: 'blog-pages-007',
      },
      latestDeploy: {
        DeployId: '007',
        Status: 'normal',
        HasTraffic: true,
        IsReleasing: false,
        FlowRatio: 100,
      },
    },
  };
}
test('configuration completion uses the actual nested task and full traffic release', () => {
  const value = task();
  assert.deepEqual(blogConfigRelease(value, 'env'), {
    taskId: '12',
    kind: 'CONFIG',
    status: 'finished',
    ready: true,
  });
  value.data.latestDeploy.IsReleasing = true;
  assert.equal(blogConfigRelease(value, 'env').ready, false);
  value.data.latestDeploy.IsReleasing = false;
  value.data.latestDeploy.DeployId = '006';
  assert.equal(blogConfigRelease(value, 'env').ready, false);
});
test('configuration metadata cannot name another environment or service', () => {
  assert.throws(() => blogConfigRelease(task(), 'other'), /Exact Blog/);
  const value = task();
  value.data.task.ServerName = 'another-app';
  assert.throws(() => blogConfigRelease(value, 'env'), /Exact Blog/);
});
test('formal gateway propagation is retried by reads without submitting another config change', async () => {
  let time = 0;
  let reads = 0;
  await waitForBlogIndexing({
    releaseId: sha,
    previewOnly: false,
    read: async () => {
      reads++;
      return {
        releaseId: sha,
        temporaryReleaseId: sha,
        previewOnly: time < 20,
        formalNoindex: time < 20,
        temporaryNoindex: true,
      };
    },
    now: () => time,
    pause: async () => {
      time += 10;
    },
    timeoutMs: 40,
  });
  assert.equal(reads, 3);
});
test('a different program is never treated as propagation delay', async () => {
  await assert.rejects(
    waitForBlogIndexing({
      releaseId: sha,
      previewOnly: false,
      read: async () => ({ releaseId: 'b'.repeat(40), temporaryReleaseId: sha }),
    }),
    /changed program/,
  );
});
test('unconfirmed convergence includes only non-secret observed state in its error', async () => {
  let time = 0;
  await assert.rejects(
    waitForBlogIndexing({
      releaseId: sha,
      previewOnly: false,
      read: async () => ({
        releaseId: sha,
        temporaryReleaseId: sha,
        previewOnly: true,
        formalNoindex: true,
        temporaryNoindex: true,
      }),
      now: () => time,
      pause: async () => {
        time += 10;
      },
      timeoutMs: 20,
    }),
    /did not converge.*formalNoindex/,
  );
});
