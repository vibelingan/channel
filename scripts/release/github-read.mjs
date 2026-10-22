import { fetchFully } from '../smoke-http.mjs';

export function createGithubReadClient({ policy, token, request = fetchFully }) {
  if (
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(policy.repository) ||
    !/^refs\/heads\/[A-Za-z0-9_/-]+$/.test(policy.trustedRef) ||
    typeof token !== 'string' ||
    !token
  )
    throw new Error('Pinned GitHub source and read token required');
  const base = `https://api.github.com/repos/${policy.repository}`;
  const get = (path, { redirect = 'error' } = {}) =>
    request('GET', base + path, {
      timeoutMs: 15_000,
      maxBytes: 2_097_152,
      redirect,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'channel-static-canary',
      },
    });
  const api = async (path) => {
    if (!/^\/actions\//.test(path) || path.includes('..'))
      throw new Error('Invalid GitHub API path');
    const result = await get(path);
    if (result.status !== 200) throw new Error('GitHub API read failed');
    return JSON.parse(result.body.toString('utf8'));
  };
  return Object.freeze({
    get,
    api,
    async requireCI(codeSha) {
      if (!/^[a-f0-9]{40}$/.test(codeSha)) throw new Error('Invalid executor SHA');
      const result = await api(
        `/actions/workflows/seo-module-1.yml/runs?head_sha=${codeSha}&status=completed&per_page=100`,
      );
      if (
        !result.workflow_runs?.some(
          (run) =>
            run.head_sha === codeSha &&
            run.path === '.github/workflows/seo-module-1.yml' &&
            run.event === 'push' &&
            run.head_branch === policy.trustedRef.slice(11) &&
            run.status === 'completed' &&
            run.conclusion === 'success' &&
            run.repository?.full_name === policy.repository &&
            run.head_repository?.full_name === policy.repository,
        )
      )
        throw new Error('Exact executor SHA has no successful offline CI');
    },
  });
}
