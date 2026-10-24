import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { validateBlogArtifactSource } from './blog/github-source.mjs';
import { sha256 } from './release/input.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import {
  assertSiteDeliveryInvocation,
  SITE_DELIVERY_POLICY as policy,
} from './release/site-policy.mjs';
const run = {
  id: 101,
  run_attempt: 1,
  path: policy.workflowPath,
  event: 'workflow_dispatch',
  head_branch: 'feat/seo-foundation',
  head_sha: 'a'.repeat(40),
  status: 'completed',
  conclusion: 'success',
  repository: { id: 7, full_name: policy.repository },
  head_repository: { id: 7, full_name: policy.repository },
};
const artifact = {
  id: 11,
  name: 'site-payload-101-1',
  expired: false,
  expires_at: '2099-01-01T00:00:00Z',
  size_in_bytes: 1024,
  digest: `sha256:${'a'.repeat(64)}`,
  workflow_run: {
    id: 101,
    repository_id: 7,
    head_repository_id: 7,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
  },
};
test('formal archives authenticate exact producer and are never confused with dummy payloads', () => {
  const options = {
    sourcePolicy: policy,
    artifactPrefix: 'site-payload',
    maxArchiveBytes: 512 * 1024 * 1024,
  };
  assert.equal(validateBlogArtifactSource(artifact, run, options).artifact.id, '11');
  for (const changed of [
    { event: 'pull_request' },
    { head_branch: 'main' },
    { path: '.github/workflows/other.yml' },
    { repository: { id: 8, full_name: policy.repository } },
  ])
    assert.throws(() => validateBlogArtifactSource(artifact, { ...run, ...changed }, options));
  assert.throws(() =>
    validateBlogArtifactSource({ ...artifact, name: 'blog-dummy-payload-101-1' }, run, options),
  );
});
test('real ZIP extraction checks digest, preserves exact content and never sends API credentials to object storage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'site-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'site.zip');
  execFileSync('python3', [
    '-c',
    `import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for name in ('payload-manifest.json','static-manifest.json','product-snapshot.json','compatibility.json','index.html'): z.writestr(name,name)
`,
    file,
  ]);
  const bytes = readFileSync(file);
  const metadata = { ...artifact, digest: `sha256:${sha256(bytes)}`, size_in_bytes: bytes.length };
  const requests = [];
  let sourceRun = run;
  const client = createSiteGithubSource({
    token: 'private-api-token',
    request: async (method, url, options) => {
      requests.push({ url, headers: options.headers });
      if (url === 'https://storage.example/release') return { status: 200, body: bytes };
      if (url.endsWith('/zip'))
        return {
          status: 302,
          headers: new Headers({ location: 'https://storage.example/release' }),
        };
      return {
        status: 200,
        body: Buffer.from(JSON.stringify(url.includes('/attempts/') ? sourceRun : metadata)),
      };
    },
  });
  const output = join(root, 'download');
  assert.equal((await client.download('11', output, { acceptedRunId: '101' })).runId, '101');
  assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), 'index.html');
  sourceRun = { ...run, status: 'in_progress', conclusion: null };
  await assert.rejects(
    client.download('11', join(root, 'not-current'), { acceptedRunId: '101' }),
    /Untrusted/,
  );
  const current = await client.download('11', join(root, 'current-accepted'), {
    acceptedRunId: '101',
    currentRunId: '101',
  });
  assert.equal(current.runId, '101');
  await assert.rejects(
    client.download('11', join(root, 'wrong-current'), {
      acceptedRunId: '101',
      currentRunId: '102',
    }),
    /Untrusted/,
  );

  assert.equal(
    requests.find((r) => r.url.startsWith('https://storage.example')).headers?.authorization,
    undefined,
  );
});
test('malformed archive members fail before writing an extraction directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'site-zip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['../outside', '/absolute', 'safe%2fescaped']) {
    const file = join(root, 'bad.zip');
    execFileSync('python3', [
      '-c',
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr(sys.argv[2],"x")',
      file,
      name,
    ]);
    assert.throws(() =>
      execFileSync(
        'python3',
        ['scripts/release/extract-site-payload.py', file, join(root, 'out')],
        { stdio: 'pipe' },
      ),
    );
  }
});
test('formal publication reuses the existing queue and leaves normal deploy triggers unchanged', () => {
  const root = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  const child = parse(readFileSync('.github/workflows/seo-site-delivery.yml', 'utf8'));
  assert.equal(root.jobs.site_delivery.uses, './.github/workflows/seo-site-delivery.yml');
  assert.equal(root.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(root.concurrency['cancel-in-progress'], false);
  assert.equal(child.jobs.site.environment, 'test');
  assert.equal(child.concurrency, undefined);
  assert.deepEqual(Object.keys(child.on), ['workflow_call']);
  const valid = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: policy.repository,
    GITHUB_REF: policy.trustedRef,
    TCB_ENV_ID: policy.envId,
    SITE_URL: policy.siteOrigin,
    CLOUDBASE_REGION: policy.region,
    SITE_DELIVERY_MODE: 'publish',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    SITE_DELIVERY_CONFIRM: 'FORMAL_SITE_ONLY',
  };
  assert.equal(assertSiteDeliveryInvocation(valid), policy);
  assert.equal(assertSiteDeliveryInvocation({ ...valid, SITE_PRODUCT_SOURCE: 'accepted' }), policy);
  assert.throws(() => assertSiteDeliveryInvocation({ ...valid, SITE_PRODUCT_SOURCE: 'skip' }));
  assert.throws(() =>
    assertSiteDeliveryInvocation({ ...valid, SITE_DELIVERY_FAULT: 'after-upload' }),
  );
  assert.throws(() =>
    assertSiteDeliveryInvocation({
      ...valid,
      SITE_DELIVERY_FAULT: 'after-upload',
      SITE_ARTICLE_TASK_ID: 'auto',
    }),
  );
  const drill = {
    ...valid,
    SITE_DELIVERY_FAULT: 'after-upload',
    SITE_ARTICLE_TASK_ID: `release-${'b'.repeat(64)}`,
  };
  assert.equal(assertSiteDeliveryInvocation(drill), policy);
  assert.throws(() => assertSiteDeliveryInvocation({ ...drill, SITE_DELIVERY_MODE: 'restore' }));
  for (const field of Object.keys(valid))
    assert.throws(() => assertSiteDeliveryInvocation({ ...valid, [field]: 'bad' }));
});
