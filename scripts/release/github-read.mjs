import { setTimeout as delay } from 'node:timers/promises';
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
  const get = async (path, { redirect = 'error', freshArtifact = false } = {}) => {
    const read = () =>
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
    let result = await read();
    if (freshArtifact && /^\/actions\/artifacts\/[1-9][0-9]*(?:\/zip)?$/.test(path)) {
      const isZip = path.endsWith('/zip');
      for (const delayMs of [500, 1500, 4000]) {
        const missingRedirect = isZip && result.status === 302 && !result.headers?.has('location');
        if (!missingRedirect && ![404, 500, 502, 503, 504].includes(result.status)) break;
        const endpoint = isZip ? 'ZIP download' : 'metadata';
        console.warn(
          `GitHub artifact ${endpoint} returned HTTP ${result.status}${missingRedirect ? ' with no Location' : ''}. Retrying the same read.`,
        );
        await delay(delayMs);
        result = await read();
      }
    }
    return result;
  };
  const api = async (path, { freshArtifact = false } = {}) => {
    if (!/^\/actions\//.test(path) || path.includes('..'))
      throw new Error('Invalid GitHub API path');
    const result = await get(path, { freshArtifact });
    if (result.status !== 200) throw new Error(`GitHub API read failed (HTTP ${result.status})`);
    return JSON.parse(result.body.toString('utf8'));
  };
  return Object.freeze({
    get,
    api,
    async requireCI(codeSha, { ref = policy.trustedRef, allowManual = false } = {}) {
      if (!/^[a-f0-9]{40}$/.test(codeSha)) throw new Error('Invalid executor SHA');
      if (ref !== policy.trustedRef && ref !== 'refs/heads/test')
        throw Error('Unapproved executor ref');
      // GitHub's status-filtered list can omit a completed run. Check status on each result.
      const result = await api(
        `/actions/workflows/seo-module-1.yml/runs?head_sha=${codeSha}&per_page=100`,
      );
      if (
        !result.workflow_runs?.some(
          (run) =>
            run.head_sha === codeSha &&
            run.path === '.github/workflows/seo-module-1.yml' &&
            (run.event === 'push' || (allowManual && run.event === 'workflow_dispatch')) &&
            run.head_branch === ref.slice(11) &&
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
