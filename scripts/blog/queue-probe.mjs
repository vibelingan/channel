import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchFully } from '../smoke-http.mjs';
const url = 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com/api/admin';
export async function readArticleQueueProbe({ key, request = fetchFully }) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
    throw Error('Restricted queue query key required');
  const response = await request('POST', url, {
    timeoutMs: 15000,
    maxBytes: 2048,
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'articleQueueStatus', token: key }),
  });
  if (
    response.status !== 200 ||
    !/(?:^|,)\s*no-store(?:\s|,|$)/i.test(response.headers.get('cache-control') ?? '')
  )
    throw Error('Queue response is unavailable or cacheable');
  const value = JSON.parse(response.body.toString('utf8'));
  const state = value?.data;
  if (
    value?.ok !== true ||
    !state ||
    ['enabled', 'hasQueued', 'hasUnknown'].some((k) => typeof state[k] !== 'boolean')
  )
    throw Error('Invalid queue response');
  return { enabled: state.enabled, hasQueued: state.hasQueued, hasUnknown: state.hasUnknown };
}
/** Prove the same key cannot read drafts, and a wrong key cannot inspect the queue. */
export async function verifyArticleQueueProbe({ key, request = fetchFully }) {
  const status = await readArticleQueueProbe({ key, request });
  const wrongKey = `${key[0] === 'a' ? 'b' : 'a'}${key.slice(1)}`;
  for (const body of [
    { action: 'articleQueueStatus', token: wrongKey },
    { action: 'articleDrafts', token: key, data: { operation: 'list', limit: 1 } },
  ]) {
    const denied = await request('POST', url, {
      timeoutMs: 15000,
      maxBytes: 2048,
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (denied.status !== 401 || JSON.parse(denied.body.toString()).error?.code !== 'UNAUTHORIZED')
      throw Error('Restricted queue credential boundary failed');
  }
  return { ...status, restrictedCredential: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyArticleQueueProbe({ key: process.env.BLOG_QUEUE_STATUS_KEY });
  if (process.argv[2])
    await writeFile(resolve(process.argv[2]), JSON.stringify(result, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  console.log(JSON.stringify(result));
}
