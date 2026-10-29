import { fetchFully } from '../smoke-http.mjs';
/** The fixed environment endpoint reports the program actually running, independently of SDK update receipts. */
export async function readFunctionRuntimeState(envId, name, request = fetchFully) {
  if (!['admin', 'public-api'].includes(name)) throw Error('Unplanned Blog function');
  if (!/^[A-Za-z0-9-]+$/.test(envId)) throw Error('Explicit admin environment required');
  const response = await request(
    name === 'admin' ? 'POST' : 'GET',
    `https://${envId}.service.tcloudbase.com/api${name === 'admin' ? '/admin' : '/health'}`,
    {
      headers: { 'content-type': 'application/json' },
      ...(name === 'admin' ? { body: JSON.stringify({ action: 'health' }) } : {}),
      redirect: 'error',
    },
  );
  const health = JSON.parse(response.body.toString());
  if (
    response.status !== 200 ||
    health.ok !== true ||
    health.data?.service !== name ||
    health.data.status !== 'ok' ||
    typeof health.data.releaseId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(health.data.releaseId)
  )
    throw Error('Blog function runtime health was not confirmed');
  return {
    releaseId: health.data.releaseId,
    catalogSeoRecording: health.data.catalogSeoRecording === true,
    articleDeliveryMode: ['static', 'server'].includes(health.data.articleDeliveryMode)
      ? health.data.articleDeliveryMode
      : undefined,
    articlePublishingEnabled:
      typeof health.data.articlePublishingEnabled === 'boolean'
        ? health.data.articlePublishingEnabled
        : undefined,
    articlePublicReadEnabled:
      typeof health.data.articlePublicReadEnabled === 'boolean'
        ? health.data.articlePublicReadEnabled
        : undefined,
  };
}

export const readFunctionRuntimeVersion = async (envId, name, request) =>
  (await readFunctionRuntimeState(envId, name, request)).releaseId;
export const readAdminRuntimeVersion = (envId, request) =>
  readFunctionRuntimeVersion(envId, 'admin', request);
