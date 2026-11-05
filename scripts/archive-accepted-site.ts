import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import COS from 'cos-nodejs-sdk-v5';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { ARCHIVE_COS_OPTIONS, createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { createPrivateArchive } from './release/private-archive.mjs';
import {
  archiveAcceptedSite,
  assertSiteArchiveInvocation,
  createSiteArchiveDiagnostic,
} from './release/site-archive.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { createSiteRetention } from './release/site-retention.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';

const directory = resolve('output/site-archive');
const diagnostic = createSiteArchiveDiagnostic({
  file: resolve(directory, 'receipt.json'),
  log: (line: string) => console.log(line),
});
const env = process.env;
try {
  const policy = assertSiteArchiveInvocation(env);
  const secretId = env.TENCENTCLOUD_SECRETID;
  const secretKey = env.TENCENTCLOUD_SECRETKEY;
  if (!secretId || !secretKey) throw Error('Existing GitHub cloud credentials required');
  diagnostic.observe({ stage: 'invocation-checked', executorSha: env.GITHUB_SHA });
  const source = createSiteGithubSource({ token: env.GITHUB_TOKEN });
  await source.requireCI(env.GITHUB_SHA, {
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  });
  diagnostic.observe({ stage: 'ci-approved' });
  const config = {
    env: policy.envId,
    region: policy.region,
    secretId,
    secretKey,
  };
  const sdk = blogWorkerSdk(config);
  const db = sdk.database();
  const manager = new CloudBase({ ...config, envId: policy.envId });
  const cos = new COS({
    SecretId: secretId,
    SecretKey: secretKey,
    ...ARCHIVE_COS_OPTIONS,
  });
  const objects = createPrivateArchive({
    ...createCosArchiveTransfer({
      cos,
      policy,
      onStatus: (event: object) => diagnostic.observe({ kind: 'sdk', ...event }),
    }),
    sdk,
    manager,
    policy,
    readLifecycle: (params: COS.GetBucketLifecycleParams) => cos.getBucketLifecycle(params),
    onTransfer: (event: object) => diagnostic.observe({ kind: 'transfer', ...event }),
  });
  const retention = createSiteRetention({ db, objects, policy });
  const github = createSiteGithubSource({ token: env.GITHUB_TOKEN, retention });
  await archiveAcceptedSite({
    coordinator: createReleaseCoordinator({
      store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
      policy,
    }),
    source: github,
    github: createGithubReadClient({ policy, token: env.GITHUB_TOKEN }),
    retention,
    policy,
    directory: resolve(directory, 'payload'),
    owner: {
      ownerRunId: `site-archive-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
    },
    observe: diagnostic.observe,
  });
} catch (error) {
  if (diagnostic.record.status !== 'failed')
    diagnostic.observe({
      stage: 'failed',
      code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
    });
  // Raw SDK exceptions can include signed requests. The persisted report has the safe evidence.
  console.error('Site archive stopped; inspect output/site-archive/receipt.json before retrying.');
  process.exitCode = 1;
}
