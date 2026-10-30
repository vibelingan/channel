import { fetchFully } from '../smoke-http.mjs';
import { verifyCatalogRenderer } from './catalog-renderer.mjs';
import { sha256 } from './input.mjs';
const repository = 'vibelingan/channel';
const base = `https://api.github.com/repos/${repository}`;
export function createRendererSource({ token, request = fetchFully }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'channel-catalog-renderer',
  };
  const api = async (method, path, data) => {
    if (!/^\/releases(?:[/?]|$)/.test(path) || path.includes('..'))
      throw Error('Invalid renderer API path');
    const result = await request(method, base + path, {
      headers,
      redirect: 'error',
      body: data === undefined ? undefined : JSON.stringify(data),
      timeoutMs: 30000,
      maxBytes: 2097152,
    });
    if (result.status === 404) return null;
    if (![200, 201].includes(result.status))
      throw Error(`Renderer release API failed (${result.status})`);
    return JSON.parse(result.body.toString('utf8'));
  };
  const bytes = async (asset) => {
    if (
      !Number.isSafeInteger(asset?.id) ||
      asset.id < 1 ||
      asset.state !== 'uploaded' ||
      asset.size > 128 * 1024 * 1024
    )
      throw Error('Invalid renderer release asset');
    const result = await request('GET', `${base}/releases/assets/${asset.id}`, {
      headers: { ...headers, accept: 'application/octet-stream' },
      redirect: 'manual',
      timeoutMs: 60000,
      maxBytes: 128 * 1024 * 1024,
    });
    let body = result;
    if (result.status === 302) {
      const url = new URL(result.headers.get('location'));
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'release-assets.githubusercontent.com' ||
        url.username ||
        url.password
      )
        throw Error('Unexpected renderer asset destination');
      body = await request('GET', url.href, {
        redirect: 'error',
        timeoutMs: 60000,
        maxBytes: 128 * 1024 * 1024,
      });
    }
    if (body.status !== 200 || body.body.length !== asset.size)
      throw Error('Incomplete renderer release asset');
    return body.body;
  };
  return {
    api,
    async upload(releaseId, name, buffer) {
      if (
        !Number.isSafeInteger(releaseId) ||
        releaseId < 1 ||
        !['renderer.json', 'renderer.tar.gz'].includes(name) ||
        !Buffer.isBuffer(buffer)
      )
        throw Error('Invalid renderer upload');
      const result = await request(
        'POST',
        `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${name}`,
        {
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body: buffer,
          redirect: 'error',
          timeoutMs: 60000,
          maxBytes: 2097152,
        },
      );
      if (result.status !== 201)
        throw Error('Renderer asset upload needs readback; do not blindly repeat');
    },
    async download(approved) {
      const release = await api('GET', `/releases/${approved.releaseId}`);
      if (
        !release ||
        release.draft ||
        release.tag_name !== `seo-renderer-${approved.codeSha}` ||
        release.target_commitish !== approved.codeSha
      )
        throw Error('Renderer release identity differs');
      const asset = (name) => {
        const matches = release.assets.filter((a) => a.name === name);
        if (matches.length !== 1) throw Error('Missing or duplicate renderer asset');
        return matches[0];
      };
      const manifestBytes = await bytes(asset('renderer.json'));
      if (sha256(manifestBytes) !== approved.manifestSha256)
        throw Error('Renderer manifest differs');
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const archive = await bytes(asset('renderer.tar.gz'));
      const proof = verifyCatalogRenderer({ manifest, approved, archive });
      return { manifest, archive, proof };
    },
  };
}
