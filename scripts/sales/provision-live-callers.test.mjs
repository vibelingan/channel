import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('./provision-live-callers.mjs', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replaceAll('import.meta.url', "'file:///ops/provision-live-callers.mjs'");
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function run({ account = '100049822712', attachError = false } = {}) {
  const files = {};
  const calls = [];
  const logs = [];
  const process = {
    env: {
      TENCENTCLOUD_SECRETID: 'broad-fixture',
      TENCENTCLOUD_SECRETKEY: 'broad-secret-fixture',
    },
  };
  const cam = {
    async CreatePolicy(input) {
      calls.push(['policy', input]);
      return { PolicyId: 12 };
    },
    async AddUser(input) {
      calls.push(['user', input]);
      return {
        Name: input.Name,
        Uin: 100012345678,
        SecretId: `id-${input.Name}`,
        SecretKey: `secret-${input.Name}`,
      };
    },
    async AttachUserPolicy(input) {
      calls.push(['attach', input]);
      if (attachError) throw { code: 'UnauthorizedOperation', requestId: 'fixture-request' };
    },
  };
  await runInNewContext(`(async()=>{${source}})()`, {
    Buffer,
    URL,
    Date,
    JSON,
    Number,
    Error,
    String,
    createCipheriv,
    publicEncrypt,
    randomBytes,
    process,
    camSdk: {
      cam: {
        v20190116: {
          Client: class {
            CreatePolicy(input) {
              return cam.CreatePolicy(input);
            }
            AddUser(input) {
              return cam.AddUser(input);
            }
            AttachUserPolicy(input) {
              return cam.AttachUserPolicy(input);
            }
          },
        },
      },
    },
    stsSdk: {
      sts: {
        v20180813: {
          Client: class {
            async GetCallerIdentity() {
              return { AccountId: account };
            }
          },
        },
      },
    },
    readFile: async () => pair.publicKey.export({ type: 'spki', format: 'pem' }),
    writeFile: async (name, value) => {
      files[name] = value;
    },
    rename: async (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
    console: { log: (value) => logs.push(value) },
  });
  return { files, calls, logs, process };
}
function decrypt(file) {
  const envelope = JSON.parse(file);
  const key = privateDecrypt(
    { key: pair.privateKey, oaepHash: 'sha256' },
    Buffer.from(envelope.wrappedKey, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]),
  );
}
test('only the exact function is authorized and generated credentials are encrypted', async () => {
  const result = await run();
  const policy = JSON.parse(result.calls[0][1].PolicyDocument);
  assert.deepEqual(policy.statement[0].action, ['scf:InvokeFunctionUrl']);
  assert.equal(policy.statement[0].resource.length, 1);
  assert.ok(policy.statement[0].resource[0].endsWith('/function/sales-integration'));
  assert.equal(result.calls.filter(([kind]) => kind === 'user').length, 2);
  for (const [, input] of result.calls.filter(([kind]) => kind === 'user'))
    assert.equal(input.ConsoleLogin, 0);
  const body = decrypt(result.files['sales-callers-encrypted.json']);
  assert.equal(body.callers.length, 2);
  assert.ok(!JSON.stringify(result.files).includes('broad-secret-fixture'));
  assert.ok(!JSON.stringify(result.logs).includes('secret-channel'));
  assert.ok(!result.files['sales-callers-encrypted.json'].includes('secret-channel'));
});
test('a different account prevents every IAM mutation', async () => {
  const result = await run({ account: '999999999999' });
  assert.equal(result.calls.length, 0);
  assert.equal(result.files['sales-callers-encrypted.json'], undefined);
  assert.equal(result.process.exitCode, 1);
});
test('attachment failure retains only encrypted recovery data and stops the second caller', async () => {
  const result = await run({ attachError: true });
  assert.equal(decrypt(result.files['sales-callers-encrypted.json']).callers.length, 1);
  assert.equal(result.calls.filter(([kind]) => kind === 'user').length, 1);
  assert.equal(result.process.exitCode, 1);
  assert.equal(
    JSON.parse(result.files['sales-callers-evidence.json']).failure.code,
    'UnauthorizedOperation',
  );
});
