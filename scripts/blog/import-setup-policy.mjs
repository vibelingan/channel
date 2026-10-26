export const IMPORT_SETUP = Object.freeze({
  envId: 'diversity-123-d9grnqfux221323bb',
  region: 'ap-shanghai',
  functionName: 'article-import',
  codeSha: 'e95899acedb582e4d92931180a45427a2d5501d4',
  packageSha256: '5176aefc73bbaa754609897d6098d837fb07eba4f380fd482fefbf68212106e0',
  packageBytes: 308192,
  domain: 'diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
  path: '/api/integrations',
  integrationId: 'hermes-local-20261026',
  keyId: 'hermes-local-20261026-key',
});
export function assertImportSetupInput(env) {
  if (
    !['initialize', 'revoke'].includes(env.IMPORT_SETUP_OPERATION) ||
    !/^[a-f0-9]{64}$/.test(env.IMPORT_SETUP_KEY_DIGEST ?? '')
  )
    throw Error('An explicit setup operation and local pilot credential digest are required');
  return IMPORT_SETUP;
}
export function assertImportRoute(route) {
  const p = IMPORT_SETUP;
  if (
    !route ||
    route.Domain !== p.domain ||
    route.Path !== p.path ||
    route.UpstreamResourceType !== 'SCF' ||
    route.UpstreamResourceName !== p.functionName ||
    route.Enable !== true ||
    route.EnableSafeDomain !== false ||
    route.EnableAuth !== false ||
    route.EnablePathTransmission !== true ||
    Object.keys(route.PathRewrite ?? {}).length > 0 ||
    Object.keys(route.Extension ?? {}).length > 0 ||
    Object.keys(route.QPSPolicy ?? {}).length > 0
  )
    throw Error('The standard-domain draft route differs from its fixed scope');
}
export function pilotIntegration(before, digest, operation, now = Date.now()) {
  assertImportSetupInput({ IMPORT_SETUP_OPERATION: operation, IMPORT_SETUP_KEY_DIGEST: digest });
  const p = IMPORT_SETUP;
  if (!Number.isSafeInteger(now) || now < 0) throw Error('Explicit valid credential time required');
  if (before === null) {
    if (operation === 'revoke') throw Error('No owned pilot credential to revoke');
    return {
      _id: p.keyId,
      siteId: 'supplychainsai.com',
      integrationId: p.integrationId,
      secretDigest: digest,
      enabled: true,
      expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      configRevision: 1,
    };
  }
  if (
    before._id !== p.keyId ||
    before.siteId !== 'supplychainsai.com' ||
    before.integrationId !== p.integrationId ||
    before.secretDigest !== digest ||
    ![1, 2].includes(before.configRevision) ||
    typeof before.enabled !== 'boolean'
  )
    throw Error('Existing credential is not this owned pilot');
  if (operation === 'initialize') {
    if (
      !before.enabled ||
      before.configRevision !== 1 ||
      !(Date.parse(before.expiresAt) > now) ||
      Date.parse(before.expiresAt) > now + 2 * 60 * 60 * 1000
    )
      throw Error('Existing pilot cannot be reenabled or extended');
    return before;
  }
  return { ...before, enabled: false, configRevision: 2 };
}
