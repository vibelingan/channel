import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maintainCredentialFile } from './maintenance.mjs';

const now = Date.parse('2026-10-27T00:00:00Z');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-blog-maintenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credential.json');
  const config = {
    CHANNEL_BLOG_API_ORIGIN:
      'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
    CHANNEL_BLOG_SITE_ORIGIN: 'https://supplychainsai.com',
    CHANNEL_BLOG_INTEGRATION_ID: 'formal-connection',
    CHANNEL_BLOG_CREDENTIAL: `formal-key.${'f'.repeat(64)}`,
    CHANNEL_BLOG_MAINTENANCE: {
      expiresAt: new Date(now + 90 * 86400000).toISOString(),
      rotateAfter: new Date(now + 30 * 86400000).toISOString(),
      configRevision: 1,
    },
  };
  const save = () => writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await save();
  return { path, config, save };
}
function reply(status, data) {
  return { status, body: Buffer.from(JSON.stringify({ ok: status === 200, data })) };
}
function nextKey(rotationId) {
  return `formal-key.${createHmac('sha256', 'f'.repeat(64))
    .update(JSON.stringify(['channel-article-rotation-v1', 'formal-key', 1, rotationId]))
    .digest('hex')}`;
}
const nextState = {
  expiresAt: new Date(now + 90 * 86400000).toISOString(),
  rotateAfter: new Date(now + 30 * 86400000).toISOString(),
  configRevision: 2,
};
test('ordinary requests do not contact maintenance before rotation is due', async (t) => {
  const f = await fixture(t);
  const result = await maintainCredentialFile(f.path, {
    clock: () => now,
    request: () => {
      throw Error('Unexpected network');
    },
  });
  assert.equal(result.config.credential, f.config.CHANNEL_BLOG_CREDENTIAL);
});
test('due rotation atomically saves the candidate and removes its private recovery record', async (t) => {
  const f = await fixture(t);
  f.config.CHANNEL_BLOG_MAINTENANCE.rotateAfter = new Date(now).toISOString();
  await f.save();
  let calls = 0;
  const result = await maintainCredentialFile(f.path, {
    clock: () => now,
    request: async (_method, url, options) => {
      assert(url.endsWith('/credential-rotation'));
      assert.equal(options.redirect, 'error');
      const { rotationId } = JSON.parse(options.body);
      calls++;
      return calls === 1
        ? reply(401)
        : reply(200, { ...nextState, credential: nextKey(rotationId) });
    },
  });
  assert.equal(calls, 2);
  assert.notEqual(result.config.credential, f.config.CHANNEL_BLOG_CREDENTIAL);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(readFile(`${f.path}.rotation.json`), { code: 'ENOENT' });
});
test('a lost response can recover after the old-key overlap ends without issuing a different rotation', async (t) => {
  const f = await fixture(t);
  f.config.CHANNEL_BLOG_MAINTENANCE.rotateAfter = new Date(now).toISOString();
  await f.save();
  let candidate;
  await assert.rejects(
    maintainCredentialFile(f.path, {
      clock: () => now,
      request: async (_method, _url, options) => {
        const id = JSON.parse(options.body).rotationId;
        if (options.headers.authorization.endsWith('f'.repeat(64))) {
          candidate = nextKey(id);
          throw Object.assign(Error('Lost response'), { code: 'ETIMEDOUT' });
        }
        return reply(401);
      },
    }),
  );
  const pending = JSON.parse(await readFile(`${f.path}.rotation.json`));
  assert.equal(pending.candidateCredential, candidate);
  assert.equal((await stat(`${f.path}.rotation.json`)).mode & 0o777, 0o600);
  const result = await maintainCredentialFile(f.path, {
    clock: () => now + 2 * 86400000,
    request: async (_method, _url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${candidate}`);
      assert.equal(JSON.parse(options.body).rotationId, pending.rotationId);
      return reply(200, { ...nextState, credential: candidate });
    },
  });
  assert.equal(result.config.credential, candidate);
});
test('revoked credentials, malformed replies and concurrent operator edits never silently replace the private file', async (t) => {
  for (const mode of ['revoked', 'wrong-key', 'operator-edit']) {
    const f = await fixture(t);
    f.config.CHANNEL_BLOG_MAINTENANCE.rotateAfter = new Date(now).toISOString();
    await f.save();
    const before = await readFile(f.path, 'utf8');
    let calls = 0;
    await assert.rejects(
      maintainCredentialFile(f.path, {
        clock: () => now,
        request: async (_method, _url, options) => {
          calls++;
          if (mode === 'revoked' || calls === 1) return reply(401);
          if (mode === 'operator-edit') await writeFile(f.path, `${before}\n`);
          return reply(200, {
            ...nextState,
            credential:
              mode === 'wrong-key'
                ? `formal-key.${'e'.repeat(64)}`
                : nextKey(JSON.parse(options.body).rotationId),
          });
        },
      }),
    );
    assert.equal((await readFile(f.path, 'utf8')).trim(), before.trim());
  }
});
test('public permissions and symlink credentials are rejected', async (t) => {
  const f = await fixture(t);
  await chmod(f.path, 0o644);
  await assert.rejects(maintainCredentialFile(f.path));
  await chmod(f.path, 0o600);
  await symlink(f.path, `${f.path}.link`);
  await assert.rejects(maintainCredentialFile(`${f.path}.link`));
});
