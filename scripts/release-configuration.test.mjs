import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration, target } from './release-hosting-fixtures.mjs';
import {
  inverseHostingConfiguration,
  prepareHostingConfiguration,
} from './release/hosting-configuration.mjs';

test('cache patch changes only the two static route extensions and preserves API, cert and other headers', () => {
  const before = configuration();
  const original = structuredClone(before);
  const plan = prepareHostingConfiguration({
    target,
    before,
    previousCacheControl: 'no-store',
    cacheControl: 'no-cache',
  });
  assert.deepEqual(before, original);
  assert.equal(plan.changes.length, 1);
  const change = plan.changes[0];
  assert.equal(change.kind, 'routes');
  assert.deepEqual(Object.keys(change.args.Domain).sort(), ['Domain', 'Routes']);
  assert.deepEqual(
    change.args.Domain.Routes.map((x) => Object.keys(x).sort()),
    [
      ['Extension', 'Path'],
      ['Extension', 'Path'],
    ],
  );
  assert.equal(plan.after.gateway.Domains[0].CertId, 'preserved-cert');
  assert.deepEqual(plan.after.gateway.Domains[0].Routes[2], before.gateway.Domains[0].Routes[2]);
  assert.equal(
    plan.after.gateway.Domains[0].Routes[0].Extension.HeadersHandler.ResponseHeadersToAdd[0].Value,
    'keep',
  );
});
test('website mapping preserves supported existing flags and route details', () => {
  const before = configuration();
  before.website.WebsiteConfiguration.ErrorDocument = {
    Key: 'old-error.html',
    OriginalHttpStatus: 'true',
    Charity404: 'false',
  };
  before.website.WebsiteConfiguration.AutoAddressing = { Status: 'Enabled' };
  const plan = prepareHostingConfiguration({ target, before, errorDocument: '404.html' });
  const args = plan.changes[0].args;
  assert.equal(args.originalHttpStatus, 'true');
  assert.equal(args.charity404, 'false');
  assert.equal(args.autoAddressing, 'Enabled');
  assert.equal(args.errorDocument, '404.html');
});
test('safe inverse is conditional on the exact expected after state', () => {
  const before = configuration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    previousCacheControl: 'no-store',
    cacheControl: 'no-cache',
  });
  const inverse = inverseHostingConfiguration({ plan, current: plan.after });
  assert.deepEqual(inverse.after, before);
  const changed = structuredClone(plan.after);
  changed.gateway.Domains[0].CertId = 'new-cert';
  assert.throws(() => inverseHostingConfiguration({ plan, current: changed }));
});
test('inverse refuses old homepage fallback or stale HTML policy', () => {
  const before = configuration();
  before.website.WebsiteConfiguration.ErrorDocument.Key = 'index.html';
  const plan = prepareHostingConfiguration({ target, before, errorDocument: '404.html' });
  assert.throws(() => inverseHostingConfiguration({ plan, current: plan.after }));
  const stale = configuration();
  for (const route of stale.gateway.Domains[0].Routes.slice(0, 2))
    route.Extension.HeadersHandler.ResponseHeadersToAdd[1].Value = 'max-age=300';
  const cache = prepareHostingConfiguration({
    target,
    before: stale,
    previousCacheControl: 'max-age=300',
    cacheControl: 'no-cache',
  });
  assert.throws(() => inverseHostingConfiguration({ plan: cache, current: cache.after }));
});
test('unknown website fields, unrepresentable routes and changed static ownership fail closed', () => {
  for (const mutate of [
    (c) => {
      c.website.WebsiteConfiguration.FutureFlag = true;
    },
    (c) => {
      c.website.WebsiteConfiguration.RoutingRules = [
        {
          Condition: { KeyPrefixEquals: 'a/', HttpErrorCodeReturnedEquals: '404' },
          Redirect: { ReplaceKeyWith: 'index.html' },
        },
      ];
    },
    (c) => {
      c.gateway.Domains[0].Routes[0].UpstreamResourceName = 'other';
    },
  ]) {
    const before = configuration();
    mutate(before);
    assert.throws(() =>
      prepareHostingConfiguration({
        target,
        before,
        errorDocument: '404.html',
        cacheControl: 'no-cache',
        previousCacheControl: 'no-store',
      }),
    );
  }
});

test('missing or reassigned root static routes cannot pass a vacuous cache check', () => {
  for (const mutate of [
    (c) => {
      c.gateway.Domains[0].Routes = [];
    },
    (c) => {
      c.gateway.Domains[0].Routes[0].Enable = false;
    },
    (c) => {
      c.gateway.Domains[0].Routes[1].UpstreamResourceName = 'other';
    },
  ]) {
    const before = configuration();
    mutate(before);
    assert.throws(() => prepareHostingConfiguration({ target, before }));
  }
});
