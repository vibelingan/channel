import { strict as assert } from 'node:assert';
import test from 'node:test';
import { hashPassword, verifyPassword } from './password.ts';

test('hashPassword emits an encoded argon2id hash that verifyPassword accepts', async () => {
  const hash = await hashPassword('correct horse battery staple');

  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=3,p=1\$/);
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(hash, 'wrong password'), false);
});

test('verifyPassword fails closed for malformed hashes', async () => {
  assert.equal(await verifyPassword('not-an-argon2-hash', 'password'), false);
});
