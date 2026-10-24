import { identity, isHash } from './release/input.mjs';

/** Assess independently captured runner, HTTP and browser evidence; never performs cloud writes. */
export function assessStaticDrill(input, expectedTarget) {
  const s = input.steps;
  if (identity(input.target) !== identity(expectedTarget) || input.scope !== 'static-canary')
    throw new Error('Drill target/scope mismatch');
  if (
    !Array.isArray(s) ||
    s.length !== 3 ||
    s.map((x) => x.operation).join(',') !== 'initialize,publish,restore' ||
    s.some(
      (x) =>
        x.accepted !== true ||
        x.httpStatus !== 200 ||
        !isHash(x.sha256) ||
        typeof x.activationId !== 'string' ||
        !x.activationId,
    ) ||
    new Set(s.map((x) => x.activationId)).size !== 3 ||
    s[0].sha256 === s[1].sha256 ||
    s[0].sha256 !== s[2].sha256 ||
    s[2].restoredFromActivationId !== s[0].activationId
  )
    throw new Error('Invalid accepted A/B/A recovery evidence');
  const hashes = s.map((x) => x.sha256);
  for (const browser of [input.oldBrowser, input.newBrowser])
    if (!Array.isArray(browser) || identity(browser) !== identity(hashes))
      throw new Error('Browser did not observe A/B/A');
  if (
    input.siteActivationBefore !== input.siteActivationAfter ||
    !input.publicFingerprintsBefore ||
    !Object.keys(input.publicFingerprintsBefore).length ||
    !Object.values(input.publicFingerprintsBefore).every(isHash) ||
    identity(input.publicFingerprintsBefore) !== identity(input.publicFingerprintsAfter)
  )
    throw new Error('Existing site changed during canary');
  if (
    input.errorPage?.status !== 404 ||
    input.errorPage.noindex !== true ||
    input.errorPage.dedicated !== true ||
    input.searchNotificationAttempts !== 0 ||
    !Number.isFinite(input.restoreDurationMs) ||
    input.restoreDurationMs < 0
  )
    throw new Error('Missing 404/search/timing acceptance evidence');
  return {
    schemaVersion: 1,
    status: 'passed',
    scope: input.scope,
    target: input.target,
    baselineActivationId: s[0].activationId,
    restoredActivationId: s[2].activationId,
    restoredSha256: s[2].sha256,
    observedRecoveryMs: input.restoreDurationMs,
    api: 'not-run',
    businessDataRecovery: 'not-run',
    searchNotificationAttempts: 0,
  };
}
