import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inventoryIdentity } from './hosting-recovery.mjs';
import { configurationStateHash } from './release/hosting-configuration.mjs';
import { identity } from './release/input.mjs';

const read = (directory, name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));

/**
 * The backup was captured while CI ran. Before the first write, the live site must still be
 * exactly what it sealed: same objects and versions, same hosting configuration.
 */
export async function assertHostingBackupCurrent({ directory, provider, target }) {
  const manifest = read(directory, 'recovery-manifest.json');
  const after = read(directory, 'inventory-after.json');
  const configAfter = read(directory, 'configuration-after.json');
  if (
    identity(provider.target) !== identity(target) ||
    manifest.purpose !== 'hosting-recovery' ||
    manifest.envId !== target.envId ||
    manifest.site !== target.site ||
    after.envId !== target.envId ||
    after.site !== target.site
  )
    throw new Error('Hosting backup belongs to another target.');
  // The same namespace filter the capture applied.
  const entries = (await provider.readInventory()).filter(
    (entry) => !entry.path.startsWith('.cloudbase-backup/'),
  );
  if (identity(inventoryIdentity(entries)) !== identity(inventoryIdentity(after.entries)))
    throw new Error('Hosted files changed after the backup; capture a new backup before writing.');
  if (
    configurationStateHash(await provider.readConfiguration()) !==
    configurationStateHash(configAfter)
  )
    throw new Error('Hosting configuration changed after the backup; capture a new backup.');
  return { entries: manifest.entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { backup: { type: 'string' } } });
  const { TCB_ENV_ID, SITE_URL, TENCENTCLOUD_SECRETID, TENCENTCLOUD_SECRETKEY } = process.env;
  if (
    !values.backup ||
    !TCB_ENV_ID ||
    !SITE_URL ||
    !TENCENTCLOUD_SECRETID ||
    !TENCENTCLOUD_SECRETKEY
  )
    throw new Error('Use --backup with explicit TCB_ENV_ID, SITE_URL and deploy credentials.');
  const target = { envId: TCB_ENV_ID, site: SITE_URL.replace(/\/$/, '') };
  const { default: CloudBase } = await import('@cloudbase/manager-node');
  const { createCloudbaseHostingProvider } = await import('./release/hosting-provider.mjs');
  const provider = createCloudbaseHostingProvider({
    manager: new CloudBase({
      envId: target.envId,
      region: process.env.CLOUDBASE_REGION || 'ap-shanghai',
      secretId: TENCENTCLOUD_SECRETID,
      secretKey: TENCENTCLOUD_SECRETKEY,
    }),
    target,
  });
  const result = await assertHostingBackupCurrent({
    directory: resolve(values.backup),
    provider,
    target,
  });
  console.log(`The live site still matches the ${result.entries}-file pre-deployment backup.`);
}
