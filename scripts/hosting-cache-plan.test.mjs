import assert from 'node:assert/strict';
import test from 'node:test';
import { planHostingCacheChange } from './hosting-cache-plan.mjs';

function input() {
  return {
    envId: 'fixture-env',
    site: 'https://fixture.example',
    previousCacheControl: 'public, max-age=300, s-maxage=600',
    configuration: {
      website: { WebsiteConfiguration: { IndexDocument: { Suffix: 'index.html' } } },
      gateway: {
        Domains: [
          {
            Domain: 'fixture.example',
            AccessType: 'DIRECT',
            Enable: true,
            CertId: 'keep-cert',
            Routes: [
              ...['/', '/*'].map((Path) => ({
                Path,
                UpstreamResourceType: 'STATIC_STORE',
                UpstreamResourceName: 'staticstore',
                Enable: true,
                PathRewrite: { Prefix: '/' },
              })),
              { Path: '/api/*', UpstreamResourceType: 'FUNCTION', Enable: true },
            ],
          },
        ],
      },
    },
  };
}

test('incremental patch preserves domain identity, upstreams, certificate and API routes', () => {
  const args = input();
  const original = structuredClone(args);
  const plan = planHostingCacheChange(args);
  assert.deepEqual(args, original);
  assert.deepEqual(Object.keys(plan.forward.Domain).sort(), ['Domain', 'Routes']);
  assert.deepEqual(
    plan.forward.Domain.Routes.map((route) => route.Path),
    ['/', '/*'],
  );
  for (const route of plan.forward.Domain.Routes) {
    assert.deepEqual(Object.keys(route).sort(), ['Extension', 'Path']);
    assert.equal(route.Extension.HeadersHandler.ResponseHeadersToAdd[0].Value, 'no-cache');
  }
  assert.equal(
    plan.backout.Domain.Routes[0].Extension.HeadersHandler.ResponseHeadersToAdd[0].Value,
    args.previousCacheControl,
  );
});

test('existing unrelated extension and response headers survive the patch', () => {
  const args = input();
  args.configuration.gateway.Domains[0].Routes[0].Extension = {
    Cache: { fixture: 'preserved' },
    HeadersHandler: {
      ResponseHeadersToAdd: [{ Key: 'X-Existing', Value: 'preserved' }],
      RequestHeadersToRemove: ['x-test'],
    },
  };
  const route = planHostingCacheChange(args).forward.Domain.Routes[0];
  assert.deepEqual(route.Extension.Cache, { fixture: 'preserved' });
  assert.equal(route.Extension.HeadersHandler.ResponseHeadersToAdd[0].Key, 'X-Existing');
  assert.deepEqual(route.Extension.HeadersHandler.RequestHeadersToRemove, ['x-test']);
});

test('changed access type, route ownership or conflicting headers stop preparation', () => {
  for (const mutate of [
    (args) => {
      args.configuration.gateway.Domains[0].AccessType = 'EO';
    },
    (args) => {
      args.configuration.gateway.Domains[0].Routes[1].UpstreamResourceName = 'other';
    },
    (args) => {
      args.configuration.gateway.Domains[0].Routes[0].Extension = {
        HeadersHandler: { ResponseHeadersToRemove: ['Cache-Control'] },
      };
    },
  ]) {
    const args = input();
    mutate(args);
    assert.throws(() => planHostingCacheChange(args));
  }
});
