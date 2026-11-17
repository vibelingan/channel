// Read-only inspection using existing CI credentials; never exports them.
import fs from 'node:fs/promises';
import camSdk from 'tencentcloud-sdk-nodejs-cam';
import stsSdk from 'tencentcloud-sdk-nodejs-sts';

const credential = {
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY,
};
if (!credential.secretId || !credential.secretKey) throw Error('CI credentials are missing');
const config = { credential, region: 'ap-shanghai', profile: { httpProfile: { reqTimeout: 30 } } };
const sts = new stsSdk.sts.v20180813.Client(config);
const cam = new camSdk.cam.v20190116.Client(config);
const evidence = {
  mode: 'read-only',
  expectedAccount: '100049822712',
  inspectedAt: new Date().toISOString(),
};
try {
  const identity = await sts.GetCallerIdentity(null);
  if (identity.AccountId !== evidence.expectedAccount) throw Error('Unexpected account');
  evidence.identity = {
    account: identity.AccountId,
    type: identity.Type,
    requestId: identity.RequestId,
  };
  try {
    const role = await cam.GetRole({ RoleName: 'TCB_QcsRole' });
    evidence.role = { readable: true, name: role.RoleInfo?.RoleName, requestId: role.RequestId };
  } catch (error) {
    evidence.role = {
      readable: false,
      code: String(error.code ?? 'unknown'),
      requestId: error.requestId,
    };
  }
} catch (error) {
  evidence.failure = {
    code: String(error.code ?? 'identity-check-failed'),
    requestId: error.requestId,
  };
  process.exitCode = 1;
}
await fs.writeFile('sales-identity-inspection.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
