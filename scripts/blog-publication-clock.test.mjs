import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
const workflow = parse(readFileSync('.github/workflows/blog-publication-clock.yml', 'utf8'));
const script = workflow.jobs.dispatch.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function execute(
  rows = [],
  failure = false,
  status = { enabled: true, hasQueued: true, hasUnknown: false },
  overrides = {},
) {
  const calls = [];
  const method = () => {};
  const github = {
    rest: {
      actions: {
        listWorkflowRunsForRepo: method,
        createWorkflowDispatch: async (input) => {
          calls.push(input);
        },
      },
    },
    paginate: {
      iterator: async function* (endpoint, options) {
        assert.equal(endpoint, method);
        assert.equal(options.per_page, 100);
        if (failure) throw Error('API unavailable');
        yield { data: rows };
      },
    },
  };
  const fetchStatus = async (url, options) => {
    assert.equal(url, 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/admin');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      action: 'articleQueueStatus',
      token: 'a'.repeat(64),
    });
    return new Response(JSON.stringify({ ok: true, data: status }), {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    });
  };
  await new AsyncFunction('github', 'context', 'core', 'fetch', 'process', script)(
    github,
    { repo: { owner: 'fixture', repo: 'channel' } },
    { info: () => {} },
    overrides.fetch ?? fetchStatus,
    { env: overrides.env ?? { BLOG_QUEUE_STATUS_KEY: 'a'.repeat(64) } },
  );
  return calls;
}
test('clock defers to all five shared environment writers without dispatching or cancelling anything', async () => {
  for (const name of [
    'deploy-test',
    'seo-static-canary',
    'deploy-ai-cloudrun',
    'e2e',
    'seo-blog-dummy',
  ])
    assert.deepEqual(await execute([{ path: `.github/workflows/${name}.yml` }]), []);
});
test('empty shared queue dispatches one current test executor with structured inputs and no CloudBase secrets', async () => {
  const calls = await execute([{ path: '.github/workflows/ci.yml' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, 'test');
  assert.equal(calls[0].inputs.artifact_id, 'auto');
  assert.deepEqual(Object.keys(workflow.permissions).sort(), ['actions', 'contents']);
  assert(!JSON.stringify(workflow).includes('TENCENTCLOUD_SECRET'));
  assert.match(workflow.jobs.dispatch.if, /BLOG_PUBLICATION_CLOCK_ENABLED/);
});
test('an unreadable shared queue never becomes permission to dispatch', async () => {
  await assert.rejects(execute([], true));
});
test('all current shared environment entrypoints retain an actual pending queue and never interrupt a writer', () => {
  for (const name of ['deploy-test', 'seo-static-canary', 'deploy-ai-cloudrun', 'e2e']) {
    const flow = parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
    assert.deepEqual(flow.concurrency, {
      group: 'cloudbase-deploy-test',
      'cancel-in-progress': false,
      queue: 'max',
    });
  }
});

test('idle, paused and empty queues never start a build worker', async () => {
  for (const status of [
    { enabled: false, hasQueued: true, hasUnknown: false },
    { enabled: true, hasQueued: false, hasUnknown: false },
  ])
    assert.deepEqual(await execute([], false, status), []);
});
test('unresolved tasks, missing keys, malformed, oversized and failed responses stop without dispatch', async () => {
  await assert.rejects(execute([], false, { enabled: true, hasQueued: true, hasUnknown: true }));
  await assert.rejects(execute([], false, undefined, { env: {} }));
  for (const response of [
    new Response('no', { status: 500 }),
    new Response('not json', { headers: { 'cache-control': 'no-store' } }),
    new Response('x'.repeat(2050), { headers: { 'cache-control': 'no-store' } }),
    new Response(
      JSON.stringify({ ok: true, data: { enabled: true, hasQueued: 'yes', hasUnknown: false } }),
    ),
  ])
    await assert.rejects(execute([], false, undefined, { fetch: async () => response }));
});
