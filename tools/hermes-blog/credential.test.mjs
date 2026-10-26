import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBlogToolConfig } from './client.mjs';
test('credential generation is private, binds one group test and prints only a digest', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'channel-credential-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  const script = new URL('./create-credential.mjs', import.meta.url);
  const output = execFileSync(process.execPath, [script.pathname, directory], { encoding: 'utf8' });
  const config = JSON.parse(readFileSync(join(directory, 'credential.json'), 'utf8'));
  const registered = JSON.parse(readFileSync(join(directory, 'registration.json'), 'utf8'));
  const secret = config.CHANNEL_BLOG_CREDENTIAL.split('.')[1];
  assert.equal(registered.keyDigest, createHash('sha256').update(secret).digest('hex'));
  assert(!output.includes(secret));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'credential.json')).mode & 0o777, 0o600);
  assert.equal(readBlogToolConfig(config).taskId, 'wecom-oem-enquiry-20261026');
  assert.throws(() =>
    execFileSync(process.execPath, [script.pathname, directory], { stdio: 'ignore' }),
  );
});
