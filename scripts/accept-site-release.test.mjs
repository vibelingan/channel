import assert from 'node:assert/strict';
import test from 'node:test';
import { assessStaticDrill } from './accept-site-release.mjs';
const digest = (label) => label.repeat(64);
const target = { envId: 'fixture-env', siteOrigin: 'https://fixture.example' };
const fixture = () => ({
  target: structuredClone(target),
  scope: 'static-canary',
  steps: [
    {
      operation: 'initialize',
      activationId: 'A1',
      sha256: digest('a'),
      httpStatus: 200,
      accepted: true,
    },
    {
      operation: 'publish',
      activationId: 'B1',
      sha256: digest('b'),
      httpStatus: 200,
      accepted: true,
    },
    {
      operation: 'restore',
      activationId: 'A2',
      sha256: digest('a'),
      httpStatus: 200,
      accepted: true,
      restoredFromActivationId: 'A1',
    },
  ],
  siteActivationBefore: 'site-unchanged',
  siteActivationAfter: 'site-unchanged',
  publicFingerprintsBefore: { home: digest('c'), category: digest('d'), sitemap: digest('e') },
  publicFingerprintsAfter: { home: digest('c'), category: digest('d'), sitemap: digest('e') },
  oldBrowser: ['a', 'b', 'a'].map(digest),
  newBrowser: ['a', 'b', 'a'].map(digest),
  errorPage: { status: 404, noindex: true, dedicated: true },
  searchNotificationAttempts: 0,
  restoreDurationMs: 1250,
});
test('static acceptance requires A to B to the original A with a new activation and both browser contexts', () => {
  const input = fixture();
  const report = assessStaticDrill(input, target);
  assert.equal(report.status, 'passed');
  assert.equal(report.api, 'not-run');
  assert.equal(report.businessDataRecovery, 'not-run');
  assert.equal(report.restoredActivationId, 'A2');
});
test('wrong target, unchanged B, old activation reuse, stale browser, wrong 404 and changed business pages are rejected', () => {
  const cases = [
    (value) => {
      value.target.envId = 'other';
    },
    (value) => {
      value.steps[1].sha256 = digest('a');
    },
    (value) => {
      value.steps[2].activationId = 'A1';
    },
    (value) => {
      value.oldBrowser[2] = digest('b');
    },
    (value) => {
      value.errorPage.status = 200;
    },
    (value) => {
      value.publicFingerprintsAfter.home = digest('f');
    },
    (value) => {
      value.searchNotificationAttempts = 1;
    },
  ];
  for (const mutate of cases) {
    const input = fixture();
    mutate(input);
    assert.throws(() => assessStaticDrill(input, target));
  }
});
