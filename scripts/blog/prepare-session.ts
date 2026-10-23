import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { signSession } from '../../packages/auth/src/jwt.ts';
const directory = resolve(process.env.BLOG_DUMMY_PRIVATE_DIR ?? '');
if (!process.env.BLOG_DUMMY_PRIVATE_DIR || directory.startsWith(`${process.cwd()}/`))
  throw new Error('External private dummy directory required');
const prepared = JSON.parse(await readFile(join(directory, 'prepared.json'), 'utf8'));
const key = await readFile(join(directory, 'session-key.txt'), 'utf8');
const ttl = Math.min(3600, Math.floor((Date.parse(prepared.expiresAt) - Date.now()) / 1000));
if (ttl < 300) throw new Error('The isolated cloud test window is ending');
const sessions = [];
for (const role of ['admin', 'member'] as const) {
  const id = role === 'admin' ? 'dummy-admin' : 'dummy-member';
  const user = {
    id,
    email: `${role}@example.invalid`,
    username: `Dummy ${role}`,
    role,
    status: 'active',
  };
  const token = await signSession(
    key,
    { sub: id, email: user.email, name: user.username, role },
    ttl,
  );
  sessions.push({ role, user, token });
}
await writeFile(
  join(directory, 'sessions.json'),
  JSON.stringify({ codeSha: prepared.codeSha, permissionHash: prepared.permissionHash, sessions }),
  { mode: 0o600 },
);
console.log('Private isolated sessions prepared; no credentials printed.');
