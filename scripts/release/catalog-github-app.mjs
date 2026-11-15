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
  // Callers need proof that a matching run exists, not an unbounded history.
  const matchingRun = async (file, filters, access) => {
    const query = new URLSearchParams({ ...filters, per_page: '1', exclude_pull_requests: 'true' });
    const result = await call('GET', `${repo}/actions/workflows/${file}/runs?${query}`, access);
    if (
      !Number.isSafeInteger(result.total_count) ||
      result.total_count < 0 ||
      !Array.isArray(result.workflow_runs) ||
      result.workflow_runs.length !== Math.min(result.total_count, 1) ||
      (result.total_count > 0 &&
        (!result.workflow_runs[0] || typeof result.workflow_runs[0] !== 'object'))
    )
      throw Error('Missing matching workflow run evidence');
    return result.workflow_runs[0] ?? null;
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
      const access = await token();
      for (const event of branch === 'test' ? ['push', 'workflow_dispatch'] : ['push']) {
        const r = await matchingRun(
          file,
          { head_sha: sha, status: 'success', branch, event },
          access,
        );
        if (!r) continue;
        if (
          r.head_sha === sha &&
          r.head_branch === branch &&
          r.path === `.github/workflows/${file}` &&
          r.status === 'completed' &&
          r.conclusion === 'success' &&
          r.event === event &&
          r.repository?.full_name === 'vibelingan/channel' &&
          r.head_repository?.full_name === 'vibelingan/channel'
        )
          return true;
        throw Error('Matching CI source differs');
      }
      return false;
    },
    async runs(workflow, branch) {
      if (workflow !== 'seo-static-canary.yml' || !['feat/seo-foundation', 'test'].includes(branch))
        throw Error('Unapproved delivery workflow or branch');
      const access = await token();
      const matches = await Promise.all(
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].map(async (status) => {
          const r = await matchingRun(workflow, { branch, status }, access);
          if (
            r &&
            (r.head_branch !== branch ||
              r.status !== status ||
              r.path !== `.github/workflows/${workflow}`)
          )
            throw Error('Matching active workflow differs');
          return r;
        }),
      );
      return matches.filter(Boolean);
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
