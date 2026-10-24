import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { identity, sha256 } from './release/input.mjs';

/** Configuration values stay inside the SDK; archives contain code and HMAC references only. */
export async function captureFunctionBackups({ provider, names, output }) {
  if (
    !Array.isArray(names) ||
    !names.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !FUNCTION_NAMES.includes(name))
  )
    throw new Error('Explicit managed functions required');
  if (existsSync(output)) throw new Error('Preserve the old backup and choose a new directory');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const name of names) {
    const captured = await provider.capture(name);
    const { snapshot, bytes } = captured;
    if (
      !snapshot ||
      snapshot.status !== 'Active' ||
      snapshot.availableStatus !== 'Available' ||
      !Buffer.isBuffer(bytes) ||
      bytes.length !== snapshot.packageBytes ||
      sha256(bytes) !== snapshot.packageSha256
    )
      throw new Error(`Function backup not confirmed: ${name}`);
    writeFileSync(join(output, `${name}.zip`), bytes, { flag: 'wx', mode: 0o600 });
    entries.push({ path: `${name}.zip`, snapshot });
  }
  for (const { snapshot } of entries) {
    const after = await provider.inspect(snapshot.name);
    if (identity(after) !== identity(snapshot)) {
      // Request IDs can change on identical reads; compare the version-bearing fields.
      for (const key of [
        'status',
        'availableStatus',
        'configurationToken',
        'versionToken',
        'packageSha256',
        'packageBytes',
      ])
        if (after[key] !== snapshot[key]) throw new Error('Function changed during backup');
    }
  }
  const manifest = {
    schemaVersion: 1,
    purpose: 'function-backup',
    target: provider.target,
    capturedAt: new Date().toISOString(),
    entries,
  };
  writeFileSync(join(output, 'function-backups.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {
    TCB_ENV_ID: envId,
    SITE_URL: siteOrigin,
    CLOUDBASE_REGION: region,
    TENCENTCLOUD_SECRETID: secretId,
    TENCENTCLOUD_SECRETKEY: secretKey,
  } = process.env;
  if (
    envId !== 'diversity-123-d9grnqfux221323bb' ||
    siteOrigin !== 'https://supplychainsai.com' ||
    region !== 'ap-shanghai' ||
    !secretId ||
    !secretKey ||
    !process.argv[2]
  )
    throw new Error('Explicit shared test target and scoped management credentials required');
  const target = { envId, siteOrigin };
  const configurationKey = createHmac('sha256', secretKey)
    .update(`channel-function-observation:v1:${identity(target)}`)
    .digest();
  const provider = createCloudbaseFunctionProvider({
    manager: new CloudBase({ envId, region, secretId, secretKey }),
    target,
    region,
    names: FUNCTION_NAMES,
    configurationKey,
  });
  const manifest = await captureFunctionBackups({
    provider,
    names: FUNCTION_NAMES,
    output: resolve(process.argv[2]),
  });
  console.log(
    `Captured ${manifest.entries.length} stable online function packages without configuration secrets.`,
  );
}
