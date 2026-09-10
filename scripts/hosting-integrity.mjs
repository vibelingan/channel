import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchFully } from './smoke-http.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Build outputs only: HTML entries and every generated Astro dependency. */
export function hostedAssetManifest(dist) {
  const assets = [];
  function visit(relative = '') {
    for (const entry of readdirSync(join(dist, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && (path.startsWith('_astro/') || path.endsWith('.html'))) {
        const body = readFileSync(join(dist, path));
        assets.push({ path, bytes: body.length, sha256: digest(body) });
      }
    }
  }
  visit();
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifyHostedAssets(assets, origin, request = fetchFully) {
  if (!assets.length) throw new Error('Hosting asset manifest is empty.');
  const failures = [];
  let cursor = 0;
  // Bounded concurrency and body lifecycle reuse the existing deployment smoke.
  await Promise.all(
    Array.from({ length: Math.min(4, assets.length) }, async () => {
      while (cursor < assets.length) {
        const asset = assets[cursor++];
        try {
          const url = new URL(asset.path, `${origin.replace(/\/+$/, '')}/`);
          url.searchParams.set('asset-check', asset.sha256);
          const response = await request('GET', url.href, {
            timeoutMs: 15000,
            maxBytes: Math.max(1024, asset.bytes + 1),
            headers: { 'cache-control': 'no-cache' },
          });
          if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
          const mime = response.headers.get('content-type')?.split(';')[0].trim();
          if (
            asset.path.endsWith('.js') &&
            !['text/javascript', 'application/javascript'].includes(mime)
          ) {
            throw new Error('JavaScript MIME mismatch');
          }
          if (asset.path.endsWith('.css') && mime !== 'text/css')
            throw new Error('CSS MIME mismatch');
          if (asset.path.endsWith('.html') && mime !== 'text/html')
            throw new Error('HTML MIME mismatch');
          if (response.body.length !== asset.bytes || digest(response.body) !== asset.sha256) {
            throw new Error('Content hash mismatch');
          }
        } catch (error) {
          failures.push({
            path: asset.path,
            reason: error instanceof Error ? error.message : 'Verification failed',
          });
        }
      }
    }),
  );
  return failures.sort((a, b) => a.path.localeCompare(b.path));
}

/** Retry identical additive bytes once; never delete/recreate on an ambiguous upload. */
export async function publishVerifiedAssets({ upload, verify, log = console.log }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await upload();
    const failures = await verify();
    if (!failures.length) return attempt;
    const summary = failures.map(({ path, reason }) => `${path}: ${reason}`).join('\n');
    if (attempt === 2) throw new Error(`Hosting integrity verification failed:\n${summary}`);
    log(
      `Hosting integrity found ${failures.length} mismatch(es); retrying the same additive upload:\n${summary}`,
    );
  }
}
