import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
test('image preparation is manual, shares the existing target lock, archives first, and cannot replace credentials or other applications', () => {
  const manual = parse(
    readFileSync(new URL('../../.github/workflows/seo-static-canary.yml', import.meta.url), 'utf8'),
  );
  const flow = parse(
    readFileSync(new URL('../../.github/workflows/seo-blog-images.yml', import.meta.url), 'utf8'),
  );
  assert.equal(manual.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(manual.concurrency['cancel-in-progress'], false);
  assert.equal(flow.jobs.prepare.environment, 'test');
  assert.match(flow.jobs.prepare.if, /workflow_dispatch/);
  const source = readFileSync(new URL('./images-live.ts', import.meta.url), 'utf8');
  assert.match(source, /names: \[p.functionName\]/);
  assert.match(source, /articleImportImageJobs/);
  assert.match(source, /ADMINONLY/);
  assert(source.indexOf('uploadArtifact') < source.indexOf('provider.updateCode'));
  assert.match(source, /96fed50cf9e3ad0d4f1256fabdc64112eaad8bdc92fc8afbb31dab9361570ac8/);
  assert(
    !/createFunction|deleteFunction|manageHosting|manageGateway|setCollection|deleteCollection/.test(
      source,
    ),
  );
  assert(!/store\.write\('articleIntegrations',\s*p\.keyId/.test(source));
  assert.match(source, /expectedSnapshot: before.snapshot/);
});
