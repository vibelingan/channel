import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { identity, sha256 } from '../release/input.mjs';
import { dummyCollections } from './dummy-provider.mjs';
import { readBlogInvocation } from './invocation.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
import { readBlogSiteBaseline } from './site-baseline.mjs';

const command = process.argv[2] ?? 'plan';
if (!['plan', 'provision', 'permissions'].includes(command) || !process.env.BLOG_DUMMY_PRIVATE_DIR)
  throw new Error('Use plan/provision/permissions and a private directory outside the repository');
const privateDir = resolve(process.env.BLOG_DUMMY_PRIVATE_DIR);
const root = process.cwd();
if (privateDir.startsWith(`${root}/`))
  throw new Error('Private test sessions must remain outside the repository');
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const stateFile = join(privateDir, 'provision-journal.json');
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const mcp = await connectBlogMcp();
async function permissionHash() {
  const permissions = [];
  for (const name of dummyCollections) {
    const response = await mcp.call('queryPermissions', {
      action: 'getResourcePermission',
      resourceType: 'noSqlDatabase',
      resourceId: name,
    });
    const value = response.data?.permissions;
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      value[0].Resource !== name ||
      value[0].Permission !== 'ADMINONLY'
    )
      throw new Error('Dummy collection is not confirmed server-only');
    permissions.push(value[0]);
  }
  const opa = [];
  for (const [key, extension] of [
    ['authz.platform.extension.rego', true],
    ['authz.user.rego', false],
  ]) {
    const response = await mcp.call('queryPermissions', { action: 'getPolicy', extension });
    const item = response.data?.raw?.Item;
    if (!item || typeof item.Value !== 'string')
      throw new Error('Authorization policy could not be read');
    opa.push({ key, item });
  }
  return identity({
    collections: permissions.sort((a, b) => a.Resource.localeCompare(b.Resource)),
    opa,
  });
}

try {
  if (command === 'permissions') {
    const hash = await permissionHash();
    await writeFile(join(privateDir, 'permission-hash.txt'), hash, { mode: 0o600 });
    console.log(`Verified isolated permissions: ${hash}`);
    process.exitCode = 0;
  } else {
    const functions = await mcp.call('queryFunctions', {
      action: 'listFunctions',
      limit: 100,
      offset: 0,
    });
    const names = functions.data?.functions?.map((fn) => fn.FunctionName);
    const collections = await mcp.call('readNoSqlDatabaseStructure', {
      action: 'listCollections',
      limit: 100,
      offset: 0,
    });
    if (
      !Array.isArray(names) ||
      !Array.isArray(collections.collections) ||
      collections.pager?.Total > 100
    )
      throw new Error('Resource inventory is incomplete');
    const present = collections.collections
      .map((item) => item.TableName)
      .filter((name) => dummyCollections.includes(name));
    const hosting = await mcp.call('queryHosting', {
      action: 'findFiles',
      prefix: policy.canaryPrefix,
      maxKeys: 1000,
    });
    const files = hosting.data?.files;
    if (!Array.isArray(files) || ![false, 'false'].includes(hosting.data?.result?.IsTruncated))
      throw new Error('Dummy hosting inventory is incomplete');
    const plan = {
      schemaVersion: 1,
      codeSha,
      target: policy,
      collections: dummyCollections,
      functionName: policy.functionName,
      existingCollections: present,
      functionPresent: names.includes(policy.functionName),
      hostingFiles: files,
      baseline: await readBlogSiteBaseline(),
    };
    if (command === 'plan') {
      if (present.length || plan.functionPresent || files.length)
        throw new Error(
          'The proposed dummy namespace is occupied; inspect ownership before any write',
        );
      await writeFile(join(privateDir, 'plan.json'), JSON.stringify(plan, null, 2), {
        mode: 0o600,
      });
      console.log(
        JSON.stringify(
          {
            codeSha,
            envId: policy.envId,
            functionName: policy.functionName,
            collections: dummyCollections,
            hostingPrefix: policy.canaryPrefix,
            occupied: false,
          },
          null,
          2,
        ),
      );
    } else {
      if (process.env.BLOG_DUMMY_EXPECTED_SHA !== codeSha)
        throw new Error(
          'The expected code SHA must match the current checkout before provisioning',
        );
      let state;
      try {
        state = JSON.parse(await readFile(stateFile, 'utf8'));
      } catch {
        const reviewed = JSON.parse(await readFile(join(privateDir, 'plan.json'), 'utf8'));
        if (
          reviewed.codeSha !== codeSha ||
          present.length ||
          plan.functionPresent ||
          files.length ||
          identity(reviewed.baseline) !== identity(plan.baseline)
        )
          throw new Error('Reviewed preflight changed before provisioning');
        state = {
          codeSha,
          created: [],
          pending: null,
          functionCreated: false,
          functionPending: false,
          seeded: false,
        };
        await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      }
      if (
        state.codeSha !== codeSha ||
        present.some((name) => !state.created.includes(name) && state.pending !== name) ||
        (plan.functionPresent && !state.functionCreated && !state.functionPending)
      )
        throw new Error('Dummy resources do not match this preparation journal');
      const save = () => writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
      for (const name of dummyCollections) {
        if (!present.includes(name)) {
          state.pending = name;
          await save();
          await mcp.call('writeNoSqlDatabaseStructure', {
            action: 'createCollection',
            collectionName: name,
          });
        }
        await mcp.call('managePermissions', {
          action: 'updateResourcePermission',
          resourceType: 'noSqlDatabase',
          resourceId: name,
          permission: 'ADMINONLY',
        });
        if (!state.created.includes(name)) state.created.push(name);
        state.pending = null;
        await save();
      }
      const permission = await permissionHash();
      await writeFile(join(privateDir, 'permission-hash.txt'), permission, { mode: 0o600 });
      if (!state.seeded) {
        await mcp.call('writeNoSqlDatabaseContent', {
          action: 'insert',
          collectionName: 'blogDummy20261023Users',
          documents: [
            {
              _id: 'dummy-admin',
              role: 'admin',
              status: 'active',
              username: 'Dummy editor',
              email: 'dummy@example.invalid',
              purpose: 'isolated-blog',
              codeSha,
            },
            {
              _id: 'dummy-member',
              role: 'member',
              status: 'active',
              username: 'Dummy member',
              email: 'member@example.invalid',
              purpose: 'isolated-blog',
              codeSha,
            },
          ],
        });
        state.seeded = true;
        await save();
      }
      let key;
      try {
        key = await readFile(join(privateDir, 'session-key.txt'), 'utf8');
      } catch {
        key = randomBytes(32).toString('hex');
        await writeFile(join(privateDir, 'session-key.txt'), key, { flag: 'wx', mode: 0o600 });
      }
      const expiresAt = new Date(Date.now() + 6 * 3600000).toISOString();
      if (!plan.functionPresent) {
        const packageRoot = join(privateDir, 'functions');
        const functionDir = join(packageRoot, policy.functionName);
        await mkdir(functionDir, { recursive: true });
        const bundle = resolve('apps/functions/admin/dist-blog-dummy/index.js');
        await copyFile(bundle, join(functionDir, 'index.js'));
        await writeFile(
          join(functionDir, 'package.json'),
          JSON.stringify({
            name: 'channel-blog-dummy',
            version: '1.0.0',
            private: true,
            main: 'index.js',
          }),
        );
        state.functionPending = true;
        await save();
        await mcp.call('manageFunctions', {
          action: 'createFunction',
          force: false,
          functionRootPath: packageRoot,
          func: {
            name: policy.functionName,
            type: 'Event',
            runtime: 'Nodejs20.19',
            handler: 'index.main',
            timeout: 30,
            isWaitInstall: false,
            envVariables: {
              TCB_ENV: policy.envId,
              CHANNEL_BUILD_SHA: codeSha,
              BLOG_DUMMY_EXPECTED_CODE_SHA: codeSha,
              BLOG_DUMMY_ENABLED: '1',
              BLOG_DUMMY_EXPIRES_AT: expiresAt,
              BLOG_DUMMY_JWT_SECRET: key,
            },
          },
        });
        state.functionCreated = true;
        state.functionPending = false;
        await save();
      }
      let active = false;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const details = await mcp.call('queryFunctions', {
          action: 'getFunctionDetail',
          functionName: policy.functionName,
        });
        if (details.data?.functionDetail?.Status === 'Active') {
          active = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 2000));
      }
      if (!active)
        throw new Error(
          'The isolated function did not become active; inspect this owned function before retrying',
        );
      const health = readBlogInvocation(
        await mcp.call('manageFunctions', {
          action: 'invokeFunction',
          functionName: policy.functionName,
          params: { action: 'health' },
        }),
      );
      if (!health.ok || health.data?.codeSha !== codeSha || health.data?.envId !== policy.envId)
        throw new Error('The deployed isolated function identity could not be verified');
      await writeFile(
        join(privateDir, 'prepared.json'),
        JSON.stringify(
          {
            codeSha,
            permissionHash: permission,
            expiresAt: health.data.expiresAt,
            functionName: policy.functionName,
            envId: policy.envId,
            baseline: plan.baseline,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify(
          {
            prepared: true,
            codeSha,
            functionName: policy.functionName,
            permissionHash: permission,
            expiresAt: health.data.expiresAt,
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  await mcp.close();
}
