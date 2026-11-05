export const FORMAL_BLOG = Object.freeze({
  envId: 'diversity-123-d9grnqfux221323bb',
  siteOrigin: 'https://supplychainsai.com',
  apiOrigin: 'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
  region: 'ap-shanghai',
  functionName: 'article-import',
  integrationId: 'hermes-wecom-supplychainsai',
  keyId: 'hermes-wecom-supplychainsai-02',
  previousPackage: '5176aefc73bbaa754609897d6098d837fb07eba4f380fd482fefbf68212106e0',
  repairBaselinePackage: 'b465c0ff072398c6ad589b601951a2d24b49445de778523002efbd46f8ba0311',
});

export function formalRegistration(value, now) {
  const p = FORMAL_BLOG;
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'integrationId,keyDigest,keyId' ||
    value.keyId !== p.keyId ||
    value.integrationId !== p.integrationId ||
    !/^[a-f0-9]{64}$/.test(value.keyDigest ?? '') ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw Error('The fixed formal publisher registration is required');
  return {
    key: {
      _id: p.keyId,
      siteId: 'supplychainsai.com',
      integrationId: p.integrationId,
      secretDigest: value.keyDigest,
      enabled: true,
      expiresAt: new Date(now + 90 * 86400000).toISOString(),
      configRevision: 1,
    },
    policy: {
      _id: `managed-${p.keyId}`,
      siteId: 'supplychainsai.com',
      keyId: p.keyId,
      integrationId: p.integrationId,
      rotateAfter: new Date(now).toISOString(),
    },
  };
}
