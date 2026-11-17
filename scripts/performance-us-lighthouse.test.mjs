import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { measurementPlan, sampleMetadata } from './performance/us-lighthouse.mjs';

test('the original profile-only command keeps before/all and all nine report indexes', () => {
  const plan = measurementPlan(['mobile']);
  assert.equal(plan.profile, 'mobile');
  assert.equal(plan.phase, 'before');
  assert.equal(plan.scope, 'all');
  assert.equal(plan.repeats, 3);
  assert.deepEqual(
    plan.pages.map((page) => page.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(plan.pages[0].url, 'https://supplychainsai.com/');
  assert.deepEqual(measurementPlan(['desktop']), measurementPlan(['desktop', 'before', 'all']));
});

test('image-pages samples only the original three products and illustrated article', () => {
  const plan = measurementPlan(['mobile', 'after', 'image-pages']);
  assert.equal(plan.phase, 'after');
  assert.equal(plan.scope, 'image-pages');
  assert.deepEqual(plan.pages, [
    {
      index: 4,
      url: 'https://supplychainsai.com/products/p-003a6310-5244-4766-adfa-eb1002ad0fb4/',
    },
    {
      index: 5,
      url: 'https://supplychainsai.com/products/p-804ee5b9-209c-41b7-ae91-9c854fc8d1b4/',
    },
    {
      index: 6,
      url: 'https://supplychainsai.com/products/p-ffc81bae-b098-4d3d-a7e5-ed539db80a1e/',
    },
    {
      index: 8,
      url: 'https://supplychainsai.com/blog/oem-headphone-sample-inspection-wecom-20261027/',
    },
  ]);
  const profiles = ['mobile', 'desktop'].map((profile) =>
    measurementPlan([profile, 'after', 'image-pages']),
  );
  assert.equal(
    profiles.reduce((sum, item) => sum + item.pages.length * item.repeats, 0),
    24,
  );
});

test('phase and scope are independent explicit choices', () => {
  assert.equal(measurementPlan(['desktop', 'after', 'all']).pages.length, 9);
  assert.equal(measurementPlan(['desktop', 'before', 'image-pages']).pages.length, 4);
});

test('an article-only comparison keeps the original URL and uses six total samples', () => {
  const plans = ['mobile', 'desktop'].map((profile) =>
    measurementPlan([profile, 'before', 'article']),
  );
  for (const plan of plans)
    assert.deepEqual(plan.pages, [
      {
        index: 8,
        url: 'https://supplychainsai.com/blog/oem-headphone-sample-inspection-wecom-20261027/',
      },
    ]);
  assert.equal(
    plans.reduce((sum, plan) => sum + plan.pages.length * plan.repeats, 0),
    6,
  );
});

test('invalid or extra parameters fail before any measurement', () => {
  for (const args of [
    [],
    ['tablet'],
    ['mobile', 'later'],
    ['mobile', 'after', 'products'],
    ['mobile', 'after', 'all', 'extra'],
    ['mobile', '', 'all'],
  ])
    assert.throws(() => measurementPlan(args));
});

test('Chrome identity comes from the real host rather than the emulated user agent', () => {
  const url = 'https://supplychainsai.com/headphones/';
  const report = {
    lighthouseVersion: '13.0.1',
    requestedUrl: url,
    finalUrl: url,
    userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 Mobile',
    environment: { hostUserAgent: 'Mozilla/5.0 HeadlessChrome/157.0.8200.0 Safari/537.36' },
    audits: {
      'largest-contentful-paint': { numericValue: 1234 },
      'network-requests': {
        details: { items: [{ resourceType: 'Document', url, statusCode: 200 }] },
      },
    },
  };
  assert.deepEqual(sampleMetadata(report, url), {
    finalUrl: url,
    chromeVersion: '157.0.8200.0',
  });
  assert.equal(sampleMetadata({ ...report, environment: {} }, url).chromeVersion, null);
});

test('a missing metric, runtime failure, wrong URL or changed tool version cannot pass as a sample', () => {
  const url = 'https://supplychainsai.com/headphones/';
  const valid = {
    lighthouseVersion: '13.0.1',
    requestedUrl: url,
    finalUrl: url,
    audits: {
      'largest-contentful-paint': { numericValue: 1234 },
      'network-requests': {
        details: { items: [{ resourceType: 'Document', url, statusCode: 200 }] },
      },
    },
  };
  for (const report of [
    null,
    { ...valid, audits: {} },
    { ...valid, runtimeError: { code: 'NO_FCP' } },
    { ...valid, requestedUrl: 'https://example.com/' },
    { ...valid, finalUrl: 'https://supplychainsai.com/login/' },
    {
      ...valid,
      audits: {
        ...valid.audits,
        'network-requests': {
          details: { items: [{ resourceType: 'Document', url, statusCode: 404 }] },
        },
      },
    },
    { ...valid, lighthouseVersion: '14.0.0' },
  ])
    assert.throws(() => sampleMetadata(report, url));
});

test('the read-only workflow is manual and forwards phase/scope without a push trigger', async () => {
  const require = createRequire(new URL('../apps/site/package.json', import.meta.url));
  const { parse } = require('yaml');
  const workflow = parse(
    await readFile(
      new URL('../.github/workflows/seo-performance-baseline.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.phase.options, ['before', 'after']);
  assert.equal(workflow.on.workflow_dispatch.inputs.phase.default, 'before');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.scope.options, [
    'all',
    'image-pages',
    'article',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.scope.default, 'all');
  const steps = workflow.jobs.baseline.steps;
  assert(
    steps
      .find((step) => step.name === 'Install pinned tool in temporary directory')
      .run.includes('lighthouse@13.0.1'),
  );
  const measure = steps.find((step) => step.env?.LIGHTHOUSE_CLI);
  assert.equal(measure.env.MEASUREMENT_PHASE, '${{ inputs.phase }}');
  assert.equal(measure.env.MEASUREMENT_SCOPE, '${{ inputs.scope }}');
  assert.match(measure.run, /"\$MEASUREMENT_PHASE" "\$MEASUREMENT_SCOPE"/);
  const artifact = steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  assert.equal(artifact.if, 'always()');
  assert.equal(
    artifact.with.name,
    'seo-${{ inputs.phase }}-${{ inputs.scope }}-${{ matrix.profile }}-${{ github.run_id }}',
  );
});
