import assert from 'node:assert/strict';
import test from 'node:test';
import { configuration, domainConfiguration, target } from './release-hosting-fixtures.mjs';
import {
  assertSafeConfiguration,
  inverseHostingConfiguration,
  prepareHostingConfiguration,
  validateConfigurationChange,
} from './release/hosting-configuration.mjs';

test('404 preparation explicitly preserves status even when the error path is unchanged', () => {
  for (const flag of [undefined, 'Disabled']) {
    const before = configuration();
    before.website.WebsiteConfiguration.ErrorDocument = {
      Key: 'errors/not-found.html',
      ...(flag ? { OriginalHttpStatus: flag } : {}),
    };
    assert.throws(() => assertSafeConfiguration(before, target));
    const plan = prepareHostingConfiguration({
      target,
      before,
      errorDocument: 'errors/not-found.html',
    });
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].args.originalHttpStatus, 'Enabled');
    assertSafeConfiguration(plan.after, target);
    assert.equal(prepareHostingConfiguration({ target, before: plan.after }).changes.length, 0);
    assert.throws(() => inverseHostingConfiguration({ plan, current: plan.after }));
  }
});

test('website flags use the provider Enabled/Disabled enum', () => {
  for (const [key, value] of [
    ['OriginalHttpStatus', 'true'],
    ['Charity404', 'false'],
  ]) {
    const before = configuration();
    before.website.WebsiteConfiguration.ErrorDocument[key] = value;
    assert.throws(() =>
      prepareHostingConfiguration({ target, before, errorDocument: 'errors/not-found.html' }),
    );
  }
});

test('domain cache patch preserves all static routes, cert and other headers', () => {
  const before = domainConfiguration();
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
  assert.equal(change.kind, 'domain-headers');
  assert.deepEqual(Object.keys(change.args.Domain).sort(), ['Domain', 'Extension']);
  assert.deepEqual(plan.after.gateway.Domains[0].Routes, before.gateway.Domains[0].Routes);
  assert.equal(plan.after.gateway.Domains[0].CertId, 'preserved-cert');
  assert.equal(
    plan.after.gateway.Domains[0].Routes[0].Extension.HeadersHandler.ResponseHeadersToAdd[0].Value,
    'keep',
  );
});
test('website mapping preserves supported existing flags and route details', () => {
  const before = configuration();
  before.website.WebsiteConfiguration.ErrorDocument = {
    Key: 'old-error.html',
    OriginalHttpStatus: 'Enabled',
    Charity404: 'Disabled',
  };
  before.website.WebsiteConfiguration.AutoAddressing = { Status: 'Enabled' };
  const plan = prepareHostingConfiguration({
    target,
    before,
    errorDocument: 'errors/not-found.html',
  });
  const args = plan.changes[0].args;
  assert.equal(args.originalHttpStatus, 'Enabled');
  assert.equal(args.charity404, 'Disabled');
  assert.equal(args.autoAddressing, 'Enabled');
  assert.equal(args.errorDocument, 'errors/not-found.html');
});
test('safe inverse is conditional on the exact expected after state', () => {
  const before = domainConfiguration();
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
  const plan = prepareHostingConfiguration({
    target,
    before,
    errorDocument: 'errors/not-found.html',
  });
  assert.throws(() => inverseHostingConfiguration({ plan, current: plan.after }));
  const stale = domainConfiguration();
  stale.gateway.Domains[0].Extension.HeadersHandler.ResponseHeadersToAdd[1].Value = 'max-age=300';
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
    const before = domainConfiguration();
    mutate(before);
    assert.throws(() =>
      prepareHostingConfiguration({
        target,
        before,
        errorDocument: 'errors/not-found.html',
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

test('domain cache policy rejects new API routes, route overrides and extra mutation fields', () => {
  const before = domainConfiguration();
  const plan = prepareHostingConfiguration({
    target,
    before,
    previousCacheControl: 'no-store',
    cacheControl: 'no-cache',
  });
  for (const mutate of [
    (value) =>
      value.gateway.Domains[0].Routes.push({
        Path: '/api',
        UpstreamResourceType: 'SCF',
        Enable: true,
      }),
    (value) =>
      value.gateway.Domains[0].Routes[0].Extension.HeadersHandler.ResponseHeadersToAdd.push({
        Key: 'cache-control',
        Value: 'max-age=300',
      }),
    (value) => {
      value.gateway.Domains[0].Extension.HeadersHandler.ResponseHeadersToAdd[1].Action =
        'APPEND_IF_EXISTS_OR_ADD';
    },
  ]) {
    const config = structuredClone(plan.after);
    mutate(config);
    assert.throws(() => prepareHostingConfiguration({ target, before: config }));
  }
  for (const field of [{ Routes: [] }, { CertId: 'other' }]) {
    const change = structuredClone(plan.changes[0]);
    Object.assign(change.args.Domain, field);
    assert.throws(() => validateConfigurationChange({ change, current: before, target }));
  }
});

test('CloudBase error document uses a non-reserved path and rejects the root fallback filename', () => {
  const safe = configuration();
  safe.website.WebsiteConfiguration.ErrorDocument.Key = 'errors/not-found.html';
  assert.doesNotThrow(() => assertSafeConfiguration(safe, target));
  const reserved = structuredClone(safe);
  reserved.website.WebsiteConfiguration.ErrorDocument.Key = '404.html';
  assert.throws(() => assertSafeConfiguration(reserved, target));
});
