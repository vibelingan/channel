import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import CloudBase from '@cloudbase/manager-node';

test('the installed Manager exposes the public initialization config getter', () => {
  const manager = new CloudBase({ envId: 'fixture-env', region: 'ap-shanghai' });
  assert.equal(typeof manager.getManagerConfig, 'function');
  const config = manager.getManagerConfig();
  assert.equal(config.envId, 'fixture-env');
  assert.equal(config.region, 'ap-shanghai');
  assert.equal(manager.currentEnvironment().getEnvId(), config.envId);
});

test('production release and Blog adapters never consume private Manager configuration', () => {
  let checked = 0;
  for (const directory of ['scripts/release', 'scripts/blog']) {
    for (const name of readdirSync(directory, { recursive: true })) {
      if (!/\.(?:mjs|ts)$/.test(name)) continue;
      const file = join(directory, name);
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\bcloudBaseConfig\b/, file);
      checked++;
    }
  }
  assert(checked > 30);
});
