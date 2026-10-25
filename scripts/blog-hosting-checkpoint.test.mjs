import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBlogConfigurationCheckpoint } from './blog/hosting-checkpoint.mjs';
import { configuration } from './release-hosting-fixtures.mjs';
function setup() {
  const saved = configuration();
  saved.gateway.Domains[0].Domain = 'supplychainsai.com';
  const current = structuredClone(saved);
  current.gateway.Domains[0].UpdateTime = 'now';
  current.gateway.Domains[0].Routes.push({
    Path: '/blog',
    UpstreamResourceType: 'CBR',
    UpstreamResourceName: 'blog-pages',
    Enable: true,
    EnableAuth: false,
    EnablePathTransmission: true,
    EnableSafeDomain: false,
    PathRewrite: {},
    QPSPolicy: {},
  });
  return { saved, current };
}
test('only the approved Blog prefix can be recorded while the archived configuration stays immutable', () => {
  const f = setup();
  const original = structuredClone(f.saved);
  assertBlogConfigurationCheckpoint(f.saved, f.current, 'https://supplychainsai.com');
  assert.deepEqual(f.saved, original);
  assertBlogConfigurationCheckpoint(f.current, f.current, 'https://supplychainsai.com');
});
for (const [name, change] of [
  [
    'root upstream',
    (f) => {
      f.current.gateway.Domains[0].Routes[0].UpstreamResourceName = 'foreign';
    },
  ],
  [
    'domain headers',
    (f) => {
      f.current.gateway.Domains[0].Extension = { unexpected: true };
    },
  ],
  [
    'another Blog service',
    (f) => {
      f.current.gateway.Domains[0].Routes.at(-1).UpstreamResourceName = 'other';
    },
  ],
  [
    'path rewriting',
    (f) => {
      f.current.gateway.Domains[0].Routes.at(-1).PathRewrite = { Prefix: '/other' };
    },
  ],
  [
    'unknown Blog settings',
    (f) => {
      f.current.gateway.Domains[0].Routes.at(-1).Extension = { Cache: true };
    },
  ],
  [
    'disabled Blog',
    (f) => {
      f.current.gateway.Domains[0].Routes.at(-1).Enable = false;
    },
  ],
  [
    'unrelated Blog subroute',
    (f) => {
      f.current.gateway.Domains[0].Routes.push({
        Path: '/blog/other',
        UpstreamResourceName: 'other',
      });
    },
  ],
  [
    'website fallback',
    (f) => {
      f.current.website.WebsiteConfiguration.ErrorDocument.Key = 'index.html';
    },
  ],
])
  test(`checkpoint refuses ${name}`, () => {
    const f = setup();
    change(f);
    assert.throws(() =>
      assertBlogConfigurationCheckpoint(f.saved, f.current, 'https://supplychainsai.com'),
    );
  });

test('read-only hosting validation retains the approved Blog route, while global cache mutation stays forbidden', async () => {
  const { domainConfiguration } = await import('./release-hosting-fixtures.mjs');
  const { prepareHostingConfiguration } = await import('./release/hosting-configuration.mjs');
  const { planHostingCacheChange } = await import('./hosting-cache-plan.mjs');
  const config = domainConfiguration();
  config.gateway.Domains[0].Routes.push(setup().current.gateway.Domains[0].Routes.at(-1));
  const fixed = { envId: 'fixture-env', site: 'https://fixture.example' };
  assert.equal(prepareHostingConfiguration({ target: fixed, before: config }).changes.length, 0);
  assert.throws(
    () =>
      planHostingCacheChange({
        configuration: config,
        envId: fixed.envId,
        site: fixed.site,
        previousCacheControl: 'no-store',
      }),
    /two owned static/,
  );
  config.gateway.Domains[0].Routes.at(-1).UpstreamResourceName = 'unreviewed';
  assert.throws(() => prepareHostingConfiguration({ target: fixed, before: config }), /Unreviewed/);
});
