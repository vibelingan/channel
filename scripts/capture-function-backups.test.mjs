import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureFunctionBackups } from './capture-function-backups.mjs';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { checkFunctionArchive } from './release/function-archive.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { sha256 } from './release/input.mjs';
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'function-online-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = functionManagerFixture();
  const provider = createCloudbaseFunctionProvider({
    ...f,
    target: { envId: 'fixture-env', siteOrigin: 'https://fixture.example' },
    region: 'ap-shanghai',
    names: ['public-api'],
  });
  return { ...f, provider, names: ['public-api'], output: join(root, 'capture') };
}
test('archives actual SDK download bytes and a second stable observation without secrets or writes', async (t) => {
  const f = setup(t);
  const manifest = await captureFunctionBackups(f);
  const bytes = readFileSync(join(f.output, 'public-api.zip'));
  assert.equal(sha256(bytes), manifest.entries[0].snapshot.packageSha256);
  checkFunctionArchive(bytes, { smoke: true });
  assert(
    !readFileSync(join(f.output, 'function-backups.json'), 'utf8').includes('sdk-fixture-secret'),
  );
  assert.equal(f.state.updates, 0);
  await assert.rejects(captureFunctionBackups(f), /old backup/);
});
test('changed function identity cannot leave a completed backup manifest', async (t) => {
  const f = setup(t);
  const original = f.provider;
  f.provider = {
    ...original,
    inspect: async (name) => ({ ...(await original.inspect(name)), packageSha256: 'b'.repeat(64) }),
  };
  await assert.rejects(captureFunctionBackups(f), /changed/);
  assert.equal(existsSync(join(f.output, 'function-backups.json')), false);
  assert.equal(f.state.updates, 0);
});
