import { fetchFully } from '../smoke-http.mjs';
/** The fixed environment endpoint reports the program actually running, independently of SDK update receipts. */
export async function readAdminRuntimeVersion(envId, request = fetchFully) {
  if (!/^[A-Za-z0-9-]+$/.test(envId)) throw Error('Explicit admin environment required');
  const response = await request('POST', `https://${envId}.service.tcloudbase.com/api/admin`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'health' }),
    redirect: 'error',
  });
  const health = JSON.parse(response.body.toString());
  if (
    response.status !== 200 ||
    health.ok !== true ||
    health.data?.service !== 'admin' ||
    health.data.status !== 'ok' ||
    typeof health.data.releaseId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(health.data.releaseId)
  )
    throw Error('Admin runtime health was not confirmed');
  return health.data.releaseId;
}
