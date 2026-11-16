// One-time narrow caller registration. Broad CI credentials never leave CI.
import { createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import camSdk from 'tencentcloud-sdk-nodejs-cam';
import stsSdk from 'tencentcloud-sdk-nodejs-sts';

const ACCOUNT = '100049822712';
const RESOURCE = `qcs::scf:ap-shanghai:uin/${ACCOUNT}:namespace/diversity-123-d9grnqfux221323bb/function/sales-integration`;
const names = ['channel-sales-bff-20261116', 'channel-sales-hermes-20261116'];
const credential = {
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY,
};
if (!credential.secretId || !credential.secretKey) throw Error('CI credentials missing');
const config = { credential, region: 'ap-shanghai', profile: { httpProfile: { reqTimeout: 30 } } };
const cam = new camSdk.cam.v20190116.Client(config);
const sts = new stsSdk.sts.v20180813.Client(config);
const publicKey = await readFile(new URL('./ops-recipient-public.pem', import.meta.url));
const received = [];
const evidence = {
  account: ACCOUNT,
  resource: RESOURCE,
  action: 'scf:InvokeFunctionUrl',
  users: [],
  createdAt: new Date().toISOString(),
};

async function saveEncrypted() {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ account: ACCOUNT, callers: received })),
    cipher.final(),
  ]);
  const wrappedKey = publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key);
  await writeFile(
    'sales-callers-encrypted.json.tmp',
    JSON.stringify({
      version: 1,
      algorithm: 'RSA-OAEP-SHA256/AES-256-GCM',
      wrappedKey: wrappedKey.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }),
  );
  await rename('sales-callers-encrypted.json.tmp', 'sales-callers-encrypted.json');
  key.fill(0);
}

try {
  const identity = await sts.GetCallerIdentity(null);
  if (identity.AccountId !== ACCOUNT) throw Error('Unexpected cloud account');
  // Validate encryption and the output directory before any cloud mutation.
  await saveEncrypted();
  // A unique policy and user names make accidental re-runs fail before key rotation.
  const policy = await cam.CreatePolicy({
    PolicyName: 'ChannelSalesInvokeOnly20261116',
    Description:
      'Only invoke the existing Channel Sales Function URL; no database, deployment or IAM permissions.',
    PolicyDocument: JSON.stringify({
      version: '2.0',
      statement: [{ effect: 'allow', action: ['scf:InvokeFunctionUrl'], resource: [RESOURCE] }],
    }),
  });
  if (!Number.isSafeInteger(policy.PolicyId)) throw Error('Missing policy identity');
  evidence.policyId = policy.PolicyId;
  await writeFile('sales-callers-evidence.json', JSON.stringify(evidence));
  for (const name of names) {
    const user = await cam.AddUser({
      Name: name,
      Remark: 'Channel Sales dedicated machine caller, no console access',
      ConsoleLogin: 0,
      UseApi: 1,
    });
    const registration = { name, uin: user.Uin ? String(user.Uin) : null, phase: 'created' };
    evidence.users.push(registration);
    console.log(JSON.stringify({ registration }));
    await writeFile('sales-callers-evidence.json', JSON.stringify(evidence));
    if (user.Name !== name || !user.Uin || !user.SecretId || !user.SecretKey)
      throw Error('Incomplete caller registration');
    received.push({
      name,
      uin: String(user.Uin),
      secretId: user.SecretId,
      secretKey: user.SecretKey,
    });
    await saveEncrypted();
    registration.phase = 'encrypted';
    await cam.AttachUserPolicy({ PolicyId: policy.PolicyId, AttachUin: user.Uin });
    registration.phase = 'attached';
  }
} catch (error) {
  evidence.failure = {
    code: String(error.code ?? 'provisioning-failed'),
    requestId: error.requestId,
  };
  process.exitCode = 1;
} finally {
  await writeFile('sales-callers-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
}
