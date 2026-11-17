/** Server-to-server SCF authentication. No tenant, Sales or database policy here. */
import { createHash, createHmac } from 'node:crypto';
export type HeaderValues = Readonly<Record<string, string | readonly string[] | undefined>>;
export interface CloudCredential {
  secretId: string;
  secretKey: string;
  sessionToken?: string;
}
function single(headers: HeaderValues, name: string): string {
  const value = headers[name];
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value))
    throw Error('Missing or ambiguous platform identity');
  return value;
}
/** Only use behind the SCF platform, which overwrites these common headers. */
export function scfRuntimeCredential(
  headers: HeaderValues,
  expected: { namespace: string; name: string },
): CloudCredential {
  if (
    single(headers, 'x-scf-namespace') !== expected.namespace ||
    single(headers, 'x-scf-name') !== expected.name
  )
    throw Error('Unexpected platform context');
  single(headers, 'x-scf-request-id');
  return {
    secretId: single(headers, 'x-scf-secret-id'),
    secretKey: single(headers, 'x-scf-secret-key'),
    sessionToken: single(headers, 'x-scf-session-token'),
  };
}
function fixedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.ap-[a-z0-9-]+\.tencentscf\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw Error('A fixed HTTPS SCF function URL is required');
  return url;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Uint8Array, value: string) =>
  createHmac('sha256', key).update(value).digest();
/** TC3 signing per Tencent's SCF Function URL protocol; never logs credentials. */
export function scfCamHeaders(
  urlText: string,
  method: string,
  body: string,
  credential: CloudCredential,
  uin: string,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const url = fixedUrl(urlText);
  if (
    !/^\d{5,20}$/.test(uin) ||
    !['GET', 'POST'].includes(method) ||
    !Number.isSafeInteger(timestamp) ||
    !credential.secretId ||
    !credential.secretKey ||
    /[\r\n]/.test(credential.secretId + credential.secretKey + (credential.sessionToken ?? ''))
  )
    throw Error('Invalid SCF caller configuration');
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/scf/tc3_request`;
  const signed = 'content-type;host';
  const canonical = `${method}\n${url.pathname}\n\ncontent-type:application/json\nhost:${url.host}\n\n${signed}\n${hash(body)}`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const signature = createHmac(
    'sha256',
    hmac(hmac(hmac(`TC3${credential.secretKey}`, date), 'scf'), 'tc3_request'),
  )
    .update(toSign)
    .digest('hex');
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${credential.secretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    'Content-Type': 'application/json',
    'X-Scf-Cam-Uin': uin,
    'X-Scf-Cam-Timestamp': String(timestamp),
    ...(credential.sessionToken ? { 'X-Scf-Cam-Token': credential.sessionToken } : {}),
  };
}
/** Restrict both the signing key and application credential to the fixed function. */
export function createScfCamFetch(
  base: string,
  credential: CloudCredential,
  uin: string,
  send: typeof fetch = fetch,
): typeof fetch {
  const target = fixedUrl(base);
  scfCamHeaders(target.href, 'POST', '', credential, uin);
  return async (input, init) => {
    if (input instanceof Request || typeof init?.body !== 'string')
      throw Error('Explicit JSON request required');
    const url = fixedUrl(String(input));
    if (url.origin !== target.origin) throw Error('SCF destination changed');
    const headers = new Headers(init.headers);
    const application = headers.get('authorization');
    if (
      !application ||
      !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(application) ||
      headers.has('x-sales-authorization')
    )
      throw Error('Invalid application credential');
    headers.delete('authorization');
    headers.set('X-Sales-Authorization', application);
    const signed = scfCamHeaders(url.href, init.method ?? 'POST', init.body, credential, uin);
    for (const [key, value] of Object.entries(signed)) headers.set(key, value);
    return send(url, { ...init, headers, redirect: 'error' });
  };
}
