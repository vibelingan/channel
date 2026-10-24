import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertToolSucceeded } from './cloudbase-deploy-resources.mjs';
import { downloadHostingBackupFiles } from './hosting-backup-download.mjs';
import { sealHostingBackup } from './hosting-recovery.mjs';
import { fetchFully } from './smoke-http.mjs';

async function inventory(callTool, target) {
  const entries = [];
  let marker;
  let total;
  const seenMarkers = new Set();
  do {
    const result = await callTool('cloudbase.queryHosting', {
      action: 'listFiles',
      maxKeys: 1000,
      ...(marker ? { marker } : {}),
    });
    assertToolSucceeded(result, 'Read hosting inventory');
    const page = result.data;
    if (!Array.isArray(page?.files) || !Number.isSafeInteger(page.totalCount))
      throw new Error('Incomplete hosting inventory page.');
    if (total !== undefined && total !== page.totalCount)
      throw new Error('Hosting changed during listing.');
    total = page.totalCount;
    entries.push(
      ...page.files.map((entry) => ({
        path: entry.key,
        bytes: Number(entry.size),
        etag: entry.ETag,
        lastModified: entry.lastModified,
      })),
    );
    marker = page.isTruncated ? page.nextMarker : undefined;
    if (page.isTruncated && (!marker || seenMarkers.has(marker)))
      throw new Error('Incomplete hosting pagination.');
    seenMarkers.add(marker);
  } while (marker);
  if (entries.length !== total)
    throw new Error('Hosting inventory total differs from downloaded pages.');
  return { ...target, observedAt: new Date().toISOString(), entries };
}

async function configuration(callTool, site) {
  const website = await callTool('cloudbase.queryHosting', { action: 'websiteConfig' });
  const gateway = await callTool('cloudbase.queryGateway', {
    action: 'listRoutes',
    domain: new URL(site).hostname,
  });
  assertToolSucceeded(website, 'Read website configuration');
  assertToolSucceeded(gateway, 'Read gateway configuration');
  return { website: website.data?.websiteConfig, gateway: gateway.data?.raw };
}

/** Read-only cloud operations. A failed/incomplete capture never produces a sealed manifest. */
export async function captureHostingBackup({ callTool, target, output, request = fetchFully }) {
  if (
    !target.envId ||
    new URL(target.site).origin !== target.site ||
    !target.site.startsWith('https://')
  )
    throw new Error('Explicit environment and HTTPS origin are required.');
  const auth = await callTool('cloudbase.auth', { action: 'status' });
  if (auth.auth_status !== 'READY' || auth.current_env_id !== target.envId)
    throw new Error('Authenticated environment differs from backup target.');
  if (existsSync(output))
    throw new Error('Backup directory already exists; preserve it and use a new path.');
  mkdirSync(output, { recursive: true });
  const save = (name, value) =>
    writeFileSync(resolve(output, name), `${JSON.stringify(value, null, 2)}\n`);
  const before = await inventory(callTool, target);
  const configBefore = await configuration(callTool, target.site);
  if (
    !configBefore.gateway?.Domains?.some(
      (domain) => domain.Domain === new URL(target.site).hostname,
    )
  )
    throw new Error('Requested domain is absent from the authenticated environment.');
  save('inventory-before.json', before);
  save('configuration-before.json', configBefore);
  const directory = resolve(output, 'files');
  mkdirSync(directory);
  const cdnDomain = configBefore.website?.CdnDomain;
  if (
    cdnDomain !== undefined &&
    (typeof cdnDomain !== 'string' || !/^[a-z0-9.-]+$/i.test(cdnDomain))
  )
    throw new Error('Invalid hosting CDN domain.');
  const { contentProofs } = await downloadHostingBackupFiles({
    origin: cdnDomain ? `https://${cdnDomain}` : target.site,
    directory,
    entries: before.entries,
    storageLayout: 'sha256-path-v1',
    request,
  });
  save('content-proofs.json', contentProofs);
  const after = await inventory(callTool, target);
  const configAfter = await configuration(callTool, target.site);
  save('inventory-after.json', after);
  save('configuration-after.json', configAfter);
  const manifest = sealHostingBackup({
    directory,
    before,
    after,
    configBefore,
    configAfter,
    contentProofs,
    storageLayout: 'sha256-path-v1',
  });
  save('recovery-manifest.json', manifest);
  return manifest;
}

// Match the existing deployment's mcporter transport. No secret is passed in
// argv or printed on subprocess failure. Emergency restoration does not use this CLI.
function callTool(selector, args) {
  let output;
  try {
    output = execFileSync(
      'npx',
      ['mcporter', 'call', selector, '--args', JSON.stringify(args), '--output', 'json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    throw new Error(`Backup tool failed: ${selector}. No cloud content was changed.`);
  }
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`Backup tool returned no JSON: ${selector}`);
  return JSON.parse(output.slice(start));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  if (!values.output || !process.env.TCB_ENV_ID || !process.env.SITE_URL)
    throw new Error('Use --output with explicit TCB_ENV_ID and SITE_URL.');
  // This selects the local MCP context, not a remote domain/function mutation.
  assertToolSucceeded(
    callTool('cloudbase.auth', { action: 'set_env', envId: process.env.TCB_ENV_ID }),
    'Select backup context',
  );
  const manifest = await captureHostingBackup({
    callTool,
    output: resolve(values.output),
    target: { envId: process.env.TCB_ENV_ID, site: process.env.SITE_URL.replace(/\/$/, '') },
  });
  console.log(`Sealed ${manifest.entries.length} hosted files before deployment.`);
}
