import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import CloudBase from '@cloudbase/manager-node';
import { DefaultArtifactClient } from '@actions/artifact';
import { readFunctionRuntimeVersion } from '../blog/runtime-health.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { replaceFunctionCode } from '../release/function-replacement.mjs';

const env = process.env;
const envId = 'diversity-123-d9grnqfux221323bb';
assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
  env.GITHUB_REPOSITORY === 'vibelingan/channel' && env.GITHUB_REF === 'refs/heads/feat/seo-foundation' &&
  env.TCB_ENV_ID === envId && env.IMAGE_DELIVERY_RESTORE === 'RESTORE_ARCHIVED_PUBLIC_API_ONLY',
  'Untrusted public API recovery invocation');
assert.equal(env.IMAGE_EXPECTED_PACKAGE, '9054661c93bbe802f12f9dd47a9d87dfd56b35ce5d7dfbd6e8f98e284c57b5fd');
const archived = 'output/image-recovery-source';
const scope = JSON.parse(await readFile(`${archived}/scope.json`, 'utf8'));
const candidate = await readFile(`${archived}/before.zip`);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
assert.equal(scope.functionName, 'public-api');
assert.equal(scope.before.packageSha256, '3ff9321959620690f0958615bd3b91c0c643fa7ff16de71558bf4f7fa269f100');
assert.equal(hash(candidate), scope.before.packageSha256);
assert.equal(scope.beforeVersion, '0b9a78f635ab4dba43844debdb788869fda7598d');
const manager = new CloudBase({envId,region:'ap-shanghai',secretId:env.TENCENTCLOUD_SECRETID,secretKey:env.TENCENTCLOUD_SECRETKEY});
const provider = createCloudbaseFunctionProvider({manager,target:{envId,siteOrigin:'https://supplychainsai.com'},region:'ap-shanghai',names:['public-api'],configurationKey:undefined});
const current = await provider.capture('public-api');
assert.equal(current.snapshot.packageSha256, env.IMAGE_EXPECTED_PACKAGE, 'Live program changed; stop');
assert.equal(current.snapshot.configurationToken, scope.before.configurationToken, 'Live configuration changed; stop');
const beforeVersion = await readFunctionRuntimeVersion(envId,'public-api');
assert.equal(beforeVersion,'db9d8044f771bbfb613c06ee8f566d459725752f');
const root='output/image-recovery';
await mkdir(root,{recursive:true});
await writeFile(`${root}/current.zip`, current.bytes, {flag:'wx'});
await writeFile(`${root}/scope.json`, JSON.stringify({functionName:'public-api',before:current.snapshot,restorePackage:hash(candidate),restoreVersion:scope.beforeVersion}), {flag:'wx'});
const archive=await new DefaultArtifactClient().uploadArtifact(`image-api-recovery-before-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,[`${root}/current.zip`,`${root}/scope.json`],root,{retentionDays:90});
assert(archive.id && archive.digest,'Current program must be archived before recovery');
const result=await replaceFunctionCode({name:'public-api',provider,before:current.snapshot,original:current.bytes,candidate,beforeVersion,expectedVersion:scope.beforeVersion,readHealth:()=>readFunctionRuntimeVersion(envId,'public-api')});
await writeFile(`${root}/result.json`, JSON.stringify({archiveId:archive.id,result,restoredVersion:scope.beforeVersion,restoredPackage:hash(candidate)},null,2));
assert.equal(result.status,'accepted','Public API recovery did not reach the expected version');
console.log(JSON.stringify({status:'accepted',restoredVersion:scope.beforeVersion,archiveId:archive.id}));
