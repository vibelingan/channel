import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { BLOG_BOOTSTRAP_POLICY as p } from './blog/bootstrap-policy.mjs';
import { readBlogRuntimeSource, selectBlogApiSource } from './blog/check-api-source.mjs';
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: p.repository,
  GITHUB_REF: p.trustedRef,
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '10',
  GITHUB_RUN_ATTEMPT: '1',
  TCB_ENV_ID: p.envId,
  SITE_URL: p.siteOrigin,
  CLOUDBASE_REGION: p.region,
  BLOG_BOOTSTRAP_CONFIRM: 'BLOG_API_EXPANSION_ONLY',
  GITHUB_OUTPUT: 'fixture-output',
  GITHUB_TOKEN: 'fixture-token',
};
test('the tool and actual staged application must both have verified CI before checkout', async () => {
  const calls = [];
  const code = await selectBlogApiSource(env, {
    readSource: async () => 'b'.repeat(40),
    verify: async (sha) => {
      calls.push(sha);
    },
  });
  assert.equal(code, 'b'.repeat(40));
  assert.deepEqual(calls, ['a'.repeat(40), 'b'.repeat(40)]);
  await assert.rejects(
    selectBlogApiSource(env, {
      readSource: async () => 'b'.repeat(40),
      verify: async (sha) => {
        if (sha.startsWith('b')) throw Error('not verified');
      },
    }),
    /not verified/,
  );
});
test('invalid staged identity and a wrong branch cannot select source', async () => {
  await assert.rejects(
    selectBlogApiSource(env, { verify: async () => {}, readSource: async () => 'main' }),
    /Exact staged source/,
  );
  let accessed = false;
  await assert.rejects(
    selectBlogApiSource(
      { ...env, GITHUB_REF: 'refs/heads/main' },
      {
        verify: async () => {
          accessed = true;
        },
        readSource: async () => {
          accessed = true;
        },
      },
    ),
  );
  assert.equal(accessed, false);
});
test('staged source comes only from the fixed actual service, matching body and response header', async () => {
  const health = {
    service: 'blog-pages',
    status: 'ok',
    siteOrigin: p.siteOrigin,
    releaseId: 'b'.repeat(40),
  };
  const request = async (method, url, options) => {
    assert.equal(method, 'GET');
    assert.equal(options.redirect, 'error');
    assert(url.startsWith('https://blog-pages-298020-11-1443560658.sh.run.tcloudbase.com/'));
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(health)),
      headers: new Headers({ 'x-channel-blog-version': 'b'.repeat(40) }),
    };
  };
  assert.equal(await readBlogRuntimeSource(request), 'b'.repeat(40));
  health.siteOrigin = 'https://other.example';
  await assert.rejects(readBlogRuntimeSource(request), /actual staged Blog/);
});
test('the API entry checks the selected runtime on Node 20 without invoking pnpm; backup upload runs in an action context', () => {
  const flow = parse(readFileSync('.github/workflows/seo-blog-server-apis.yml', 'utf8'));
  const steps = flow.jobs.prepare.steps;
  const runtime = steps.findIndex((s) => s.with?.['node-version'] === '20.19.0');
  const restore = steps.findIndex((s, i) => i > runtime && s.with?.['node-version'] === '22.13.0');
  assert(runtime > 0 && restore > runtime);
  for (const step of steps.slice(runtime + 1, restore)) assert(!/\bpnpm\b/.test(step.run ?? ''));
  const smoke = steps.find((s) => s.run === 'node scripts/smoke-function-artifacts.mjs');
  assert.equal(smoke['working-directory'], 'blog-runtime-source');
  assert.equal(smoke.env.CHANNEL_EXPECTED_RELEASE, '${{ steps.source.outputs.code_sha }}');
  const backup = steps.find((s) => s.with?.script?.includes('scripts/blog/bootstrap-apis.ts'));
  assert.equal(backup.uses, 'actions/github-script@v7');
  assert(backup.with.script.includes('env:process.env'));
  const route = parse(readFileSync('.github/workflows/seo-blog-server-route.yml', 'utf8'));
  assert(
    route.jobs.route.steps.some(
      (s) =>
        s.uses === 'actions/github-script@v7' &&
        s.with?.script?.includes('scripts/blog/route-server.mjs'),
    ),
  );
});

test('staged identity tolerates bounded connection failures without retrying a wrong identity', async () => {
  const response = {
    status: 200,
    body: Buffer.from(
      JSON.stringify({
        service: 'blog-pages',
        status: 'ok',
        siteOrigin: p.siteOrigin,
        releaseId: 'b'.repeat(40),
      }),
    ),
    headers: new Headers({ 'x-channel-blog-version': 'b'.repeat(40) }),
  };
  let calls = 0;
  const pause = async () => {};
  const request = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return { ...response, status: 503 };
    return response;
  };
  assert.equal(await readBlogRuntimeSource(request, { pause }), 'b'.repeat(40));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    readBlogRuntimeSource(
      async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
      { pause },
    ),
  );
  assert.equal(calls, 3);
  for (const status of [200, 401, 403]) {
    calls = 0;
    await assert.rejects(
      readBlogRuntimeSource(
        async () => {
          calls++;
          return {
            ...response,
            status,
            headers: new Headers({ 'x-channel-blog-version': 'a'.repeat(40) }),
          };
        },
        { pause },
      ),
      /actual staged Blog/,
    );
    assert.equal(calls, 1);
  }
});
