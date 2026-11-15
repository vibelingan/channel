import { fetchFully } from '../smoke-http.mjs';

/** A function repair must include the source already running in that function. */
export async function requireFunctionSourceAncestor({
  beforeVersion,
  sourceSha,
  token,
  request = fetchFully,
}) {
  if (![beforeVersion, sourceSha].every((x) => /^[a-f0-9]{40}$/.test(x ?? '')) || !token)
    throw Error('Explicit live and candidate source identities required');
  const response = await request(
    'GET',
    `https://api.github.com/repos/vibelingan/channel/compare/${beforeVersion}...${sourceSha}?per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeoutMs: 30000,
      maxBytes: 8 * 1024 * 1024,
      redirect: 'error',
    },
  );
  if (response.status !== 200) throw Error('Cannot verify deployed source ancestry');
  const result = JSON.parse(response.body.toString('utf8'));
  if (
    !['ahead', 'identical'].includes(result.status) ||
    result.behind_by !== 0 ||
    result.merge_base_commit?.sha !== beforeVersion
  )
    throw Error(
      'Candidate source omits the currently deployed history; merge the current release first',
    );
  return { beforeVersion, sourceSha, status: result.status };
}
