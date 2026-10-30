import { createPrivateKey, sign } from 'node:crypto';
import { fetchFully } from '../smoke-http.mjs';
const root = 'https://api.github.com';
const repo = '/repos/vibelingan/channel';
export function createCatalogGithubApp({
  appId,
  installationId,
  privateKey,
  request = fetchFully,
  now = () => Date.now(),
}) {
  if (!/^[1-9][0-9]*$/.test(String(appId)) || !/^[1-9][0-9]*$/.test(String(installationId)))
    throw Error('Pinned GitHub application required');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa') throw Error('GitHub application RSA private key required');
  let cached;
  const call = async (method, path, token, body) => {
    const result = await request(method, root + path, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'channel-catalog-wakeup',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      timeoutMs: 12000,
      maxBytes: 1048576,
    });
    if (![200, 201, 204].includes(result.status))
      throw Error(`GitHub service request failed (${result.status})`);
    return result.status === 204 ? null : JSON.parse(result.body.toString('utf8'));
  };
  const token = async () => {
    if (cached && cached.expires > now() + 120000) return cached.token;
    const epoch = Math.floor(now() / 1000);
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const data = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: String(appId) })}`;
    const jwt = `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
    const installation = await call('GET', `/app/installations/${installationId}`, jwt);
    if (
      installation.account?.login !== 'vibelingan' ||
      installation.repository_selection !== 'selected'
    )
      throw Error('GitHub installation owner or selection differs');
    const value = await call('POST', `/app/installations/${installationId}/access_tokens`, jwt, {
      repositories: ['channel'],
      permissions: { actions: 'write', contents: 'read' },
    });
    if (
      typeof value.token !== 'string' ||
      !Number.isFinite(Date.parse(value.expires_at)) ||
      Date.parse(value.expires_at) <= now() + 120000 ||
      value.repository_selection !== 'selected' ||
      value.permissions?.actions !== 'write' ||
      value.permissions?.contents !== 'read'
    )
      throw Error('GitHub installation token scope differs');
    cached = { token: value.token, expires: Date.parse(value.expires_at) };
    return cached.token;
  };
  return {
    async head(branch) {
      if (!['feat/seo-foundation', 'test'].includes(branch))
        throw Error('Unapproved executor branch');
      const result = await call('GET', `${repo}/git/ref/heads/${branch}`, await token());
      if (result.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(result.object.sha))
        throw Error('Executor ref is not a commit');
      return result.object.sha;
    },
    async passedCI(sha, branch) {
      if (!/^[a-f0-9]{40}$/.test(sha) || !['feat/seo-foundation', 'test'].includes(branch))
        throw Error('Invalid CI source');
      const file = branch === 'test' ? 'deploy-test.yml' : 'seo-module-1.yml';
      const result = await call(
        'GET',
        `${repo}/actions/workflows/${file}/runs?head_sha=${sha}&status=completed&per_page=100`,
        await token(),
      );
      if (!Array.isArray(result.workflow_runs)) throw Error('Missing CI source inventory');
      return result.workflow_runs.some(
        (r) =>
          r.head_sha === sha &&
          r.head_branch === branch &&
          r.path === `.github/workflows/${file}` &&
          r.status === 'completed' &&
          r.conclusion === 'success' &&
          (r.event === 'push' || (branch === 'test' && r.event === 'workflow_dispatch')) &&
          r.repository?.full_name === 'vibelingan/channel' &&
          r.head_repository?.full_name === 'vibelingan/channel',
      );
    },
    async runs(workflow) {
      if (workflow !== 'seo-static-canary.yml') throw Error('Unapproved delivery workflow');
      const result = await call(
        'GET',
        `${repo}/actions/workflows/${workflow}/runs?per_page=100`,
        await token(),
      );
      if (!Array.isArray(result.workflow_runs)) throw Error('Missing delivery inventory');
      return result.workflow_runs;
    },
    async dispatch(workflow, body) {
      if (
        workflow !== 'seo-static-canary.yml' ||
        !['feat/seo-foundation', 'test'].includes(body.ref) ||
        body.inputs?.mode !== 'site-delivery' ||
        body.inputs?.action !== 'publish' ||
        body.inputs?.product_source !== 'refresh'
      )
        throw Error('Unapproved automatic delivery');
      await call('POST', `${repo}/actions/workflows/${workflow}/dispatches`, await token(), body);
    },
  };
}
