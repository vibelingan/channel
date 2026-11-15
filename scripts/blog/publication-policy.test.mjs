import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
test('explicit publication deployment only runs manually under the shared production lock and archives before its narrow write', () => {
  const manual = parse(
    readFileSync(new URL('../../.github/workflows/seo-static-canary.yml', import.meta.url), 'utf8'),
  );
  const flow = parse(
    readFileSync(
      new URL('../../.github/workflows/seo-blog-publication.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(manual.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(manual.concurrency['cancel-in-progress'], false);
  assert(manual.on.workflow_dispatch.inputs.mode.options.includes('blog-publication-prepare'));
  assert.match(
    manual.jobs.blog_publication_prepare.if,
    /inputs.mode == 'blog-publication-prepare'/,
  );
  assert.equal(flow.jobs.prepare.environment, 'test');
  assert.match(flow.jobs.prepare.if, /workflow_dispatch/);
  assert.equal(flow.on.workflow_call.inputs.expected_package.required, true);
  const s = readFileSync(new URL('./publication-live.ts', import.meta.url), 'utf8');
  assert.match(s, /names: \[p.functionName\]/);
  assert.match(s, /BLOG_PUBLICATION_EXPECTED_PACKAGE/);
  assert(s.indexOf('uploadArtifact') < s.indexOf('provider.updateCode'));
  assert.match(s, /expectedSnapshot: before.snapshot/);
  assert(
    !/createFunction|deleteFunction|createCollection|modifyResourcePermission|manageHosting|manageGateway/.test(
      s,
    ),
  );
  assert(!/store\.write\('articleIntegrations',\s*p\.keyId/.test(s));
  assert.match(s, /publication-access-\$\{p.keyId\}/);
});
