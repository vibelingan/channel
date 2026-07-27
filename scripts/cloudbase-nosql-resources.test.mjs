import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { REQUIRED_NOSQL_RESOURCES, ensureNoSqlResources } from './cloudbase-nosql-resources.mjs';

const deploySource = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
const smokeSource = readFileSync(new URL('./smoke-cloudbase-deploy.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mcporterConfig = JSON.parse(
  readFileSync(new URL('../config/mcporter.json', import.meta.url), 'utf8'),
);
const deploymentDesign = readFileSync(
  new URL('../docs/CLOUDBASE_DEPLOYMENT_DESIGN.md', import.meta.url),
  'utf8',
);
const deploymentExecution = readFileSync(
  new URL('../docs/CLOUDBASE_DEPLOYMENT_EXECUTION.md', import.meta.url),
  'utf8',
);
const cicdDesign = readFileSync(new URL('../docs/CICD_DESIGN.md', import.meta.url), 'utf8');
const cicdProductionPlan = readFileSync(
  new URL('../docs/CICD_PRODUCTION_PLAN.md', import.meta.url),
  'utf8',
);
const phase8TestPlan = readFileSync(
  new URL('../docs/oem-phase-1-5/PHASE8_TEST_PLAN.md', import.meta.url),
  'utf8',
);
const phase8Mius = readFileSync(
  new URL('../docs/oem-phase-1-5/PHASE8_MIUS.md', import.meta.url),
  'utf8',
);
const phase8Architecture = readFileSync(
  new URL('../docs/oem-phase-1-5/PHASE8_ARCHITECTURE.md', import.meta.url),
  'utf8',
);
const oemRefreshDesign = readFileSync(
  new URL('../docs/oem-refresh/DESIGN.md', import.meta.url),
  'utf8',
);
const oemExecution = readFileSync(
  new URL('../docs/oem-phase-1-5/EXECUTION.md', import.meta.url),
  'utf8',
);

function listedIndex(index) {
  return {
    Name: index.IndexName,
    Unique: index.MgoKeySchema.MgoIsUnique,
    Keys: index.MgoKeySchema.MgoIndexKeys,
  };
}

test('rateLimitHits declares every index used by the public endpoint limiter', () => {
  const resource = REQUIRED_NOSQL_RESOURCES.find(
    (candidate) => candidate.collectionName === 'rateLimitHits',
  );

  assert.ok(resource, 'rateLimitHits must be provisioned before public functions deploy');
  assert.equal(resource.permission, 'ADMINONLY');
  assert.deepEqual(
    resource.indexes.map((index) =>
      index.MgoKeySchema.MgoIndexKeys.map(({ Name, Direction }) => `${Name}:${Direction}`),
    ),
    [['createdAt:1'], ['scope:1', 'createdAt:1'], ['scope:1', 'sourceHash:1', 'createdAt:1']],
  );
});

test('passwordResets declares its expiry and unique token lookup indexes', () => {
  const resource = REQUIRED_NOSQL_RESOURCES.find(
    (candidate) => candidate.collectionName === 'passwordResets',
  );

  assert.ok(resource, 'passwordResets must be provisioned before public functions deploy');
  assert.equal(resource.permission, 'ADMINONLY');
  assert.deepEqual(
    resource.indexes.map((index) => ({
      name: index.IndexName,
      unique: index.MgoKeySchema.MgoIsUnique,
      keys: index.MgoKeySchema.MgoIndexKeys,
    })),
    [
      {
        name: 'password_reset_expires_at',
        unique: false,
        keys: [{ Name: 'expiresAt', Direction: '1' }],
      },
      {
        name: 'password_reset_token_hash',
        unique: true,
        keys: [{ Name: 'tokenHash', Direction: '1' }],
      },
    ],
  );
});

test('ensureNoSqlResources creates missing resources and verifies the resulting structure', () => {
  const collections = new Set();
  const indexesByCollection = new Map();
  const permissions = new Map();
  const calls = [];

  const callTool = (selector, args) => {
    calls.push({ selector, args });

    if (selector === 'cloudbase.readNoSqlDatabaseStructure') {
      if (args.action === 'checkCollection') {
        return { success: true, exists: collections.has(args.collectionName) };
      }
      if (args.action === 'listIndexes') {
        return {
          success: true,
          indexes: [...(indexesByCollection.get(args.collectionName)?.values() ?? [])].map(
            listedIndex,
          ),
        };
      }
    }

    if (selector === 'cloudbase.writeNoSqlDatabaseStructure') {
      if (args.action === 'createCollection') {
        collections.add(args.collectionName);
        indexesByCollection.set(args.collectionName, new Map());
        return { success: true };
      }
      if (args.action === 'updateCollection') {
        const existingIndexes = indexesByCollection.get(args.collectionName);
        for (const index of args.updateOptions.CreateIndexes) {
          existingIndexes.set(index.IndexName, index);
        }
        return { success: true };
      }
    }

    if (selector === 'cloudbase.queryPermissions') {
      return { success: true, data: { aclTag: permissions.get(args.resourceId) ?? 'PRIVATE' } };
    }

    if (selector === 'cloudbase.managePermissions') {
      permissions.set(args.resourceId, args.permission);
      return { success: true };
    }

    throw new Error(`Unexpected tool call: ${selector} ${JSON.stringify(args)}`);
  };

  const messages = [];
  ensureNoSqlResources(callTool, (message) => messages.push(message));

  assert.equal(collections.size, REQUIRED_NOSQL_RESOURCES.length);
  assert.equal(
    [...indexesByCollection.values()].reduce((total, indexes) => total + indexes.size, 0),
    5,
  );
  assert.deepEqual([...permissions.values()], ['ADMINONLY', 'ADMINONLY']);
  assert.equal(
    calls.filter(
      ({ selector, args }) =>
        selector === 'cloudbase.writeNoSqlDatabaseStructure' && args.action === 'createCollection',
    ).length,
    REQUIRED_NOSQL_RESOURCES.length,
  );
  assert.equal(
    calls.filter(
      ({ selector, args }) =>
        selector === 'cloudbase.writeNoSqlDatabaseStructure' && args.action === 'updateCollection',
    ).length,
    REQUIRED_NOSQL_RESOURCES.length,
  );
  assert.equal(
    calls.filter(({ selector }) => selector === 'cloudbase.managePermissions').length,
    REQUIRED_NOSQL_RESOURCES.length,
  );
  assert.ok(messages.some((message) => message.includes('rateLimitHits: ready')));
  assert.ok(messages.some((message) => message.includes('passwordResets: ready')));
});

test('ensureNoSqlResources is idempotent when the collection and indexes exist', () => {
  const calls = [];
  const callTool = (selector, args) => {
    calls.push({ selector, args });
    if (selector === 'cloudbase.readNoSqlDatabaseStructure') {
      if (args.action === 'checkCollection') return { success: true, exists: true };
      if (args.action === 'listIndexes') {
        const resource = REQUIRED_NOSQL_RESOURCES.find(
          (candidate) => candidate.collectionName === args.collectionName,
        );
        return {
          success: true,
          indexes: resource.indexes.map(listedIndex),
        };
      }
    }
    if (selector === 'cloudbase.queryPermissions') {
      return { success: true, data: { aclTag: 'ADMINONLY' } };
    }
    throw new Error(`Unexpected write call: ${selector} ${JSON.stringify(args)}`);
  };

  ensureNoSqlResources(callTool, () => {});

  assert.equal(
    calls.some(({ selector }) => selector === 'cloudbase.writeNoSqlDatabaseStructure'),
    false,
  );
  assert.equal(
    calls.some(({ args }) => args.action === 'checkIndex'),
    false,
    'CloudBase checkIndex returns false negatives for indexes listed by listIndexes',
  );
});

test('ensureNoSqlResources fails safely on a same-name index with the wrong definition', () => {
  const indexesByCollection = new Map(
    REQUIRED_NOSQL_RESOURCES.map((resource) => [
      resource.collectionName,
      new Map(resource.indexes.map((index) => [index.IndexName, index])),
    ]),
  );
  indexesByCollection.get('rateLimitHits').set('rate_limit_scope_created_at', {
    IndexName: 'rate_limit_scope_created_at',
    MgoKeySchema: {
      MgoIsUnique: false,
      MgoIndexKeys: [
        { Name: 'createdAt', Direction: '1' },
        { Name: 'scope', Direction: '1' },
      ],
    },
  });
  const writes = [];

  const callTool = (selector, args) => {
    if (selector === 'cloudbase.readNoSqlDatabaseStructure') {
      if (args.action === 'checkCollection') return { success: true, exists: true };
      if (args.action === 'listIndexes') {
        return {
          success: true,
          indexes: [...indexesByCollection.get(args.collectionName).values()].map(listedIndex),
        };
      }
    }
    if (selector === 'cloudbase.writeNoSqlDatabaseStructure') {
      writes.push(args);
      return { success: true };
    }
    if (selector === 'cloudbase.queryPermissions') {
      return { success: true, data: { aclTag: 'ADMINONLY' } };
    }
    throw new Error(`Unexpected tool call: ${selector} ${JSON.stringify(args)}`);
  };

  assert.throws(
    () => ensureNoSqlResources(callTool, () => {}),
    /rateLimitHits: index rate_limit_scope_created_at definition drift.*Refusing to replace an existing index automatically/,
  );
  assert.deepEqual(writes, []);
});

test('deploy provisions NoSQL resources before functions and smoke crosses the limiter', () => {
  assert.match(
    deploySource,
    /import \{ ensureNoSqlResources \} from '\.\/cloudbase-nosql-resources\.mjs';/,
  );
  const provisionAt = deploySource.indexOf('ensureNoSqlResources(callTool);');
  const functionDeployAt = deploySource.indexOf('for (const def of functionDefs)');
  assert.ok(provisionAt >= 0, 'deploy must provision required NoSQL resources');
  assert.ok(provisionAt < functionDeployAt, 'NoSQL resources must exist before function deploy');

  assert.match(smokeSource, /drawingFileId: '__deployment_smoke_partial_upload__'/);
  assert.match(smokeSource, /assertApiError\([^)]*'VALIDATION_ERROR'/s);
  assert.match(smokeSource, /token: '__deployment_smoke_invalid_reset_token__'/);
  assert.match(smokeSource, /assertApiError\([^)]*'BAD_REQUEST'/s);
  assert.match(smokeSource, /expectHttp\('GET', `\$\{siteUrl\}\/headphones`, 200\)/);
  assert.doesNotMatch(smokeSource, /assert\.ok\(true, '\/headphones restored'\)/);
  assert.equal(
    mcporterConfig.mcpServers.cloudbase.args[0],
    '@cloudbase/cloudbase-mcp@2.24.1',
    'deploy-time MCP contracts must be pinned to the reviewed version',
  );
  assert.equal(
    packageJson.scripts['test:deploy-smoke'],
    'node --test scripts/*.test.mjs',
    'the root deploy-smoke test command must include every script contract test',
  );
});

test('deployment docs match restored routes and post-baseline resource contracts', () => {
  assert.match(deploymentExecution, /`\/headphones` renders and `\/overstock` returns `404`/);
  assert.doesNotMatch(
    deploymentExecution,
    /Retired storefront routes `\/headphones` and `\/overstock` are pruned/,
  );
  assert.doesNotMatch(deploymentExecution, /`\/headphones` and `\/overstock` return `404`/);
  assert.doesNotMatch(deploymentExecution, /Confirm `\/headphones` and `\/overstock` return `404`/);
  assert.match(cicdDesign, /Active site pages[^\n]*`\/headphones`[^\n]*return `200`/);
  assert.match(cicdDesign, /Retired storefront route `\/overstock` returns `404`/);
  assert.doesNotMatch(cicdDesign, /Retired storefront routes `\/headphones` and `\/overstock`/);
  assert.match(deploymentDesign, /PD-1 \(superseded 2026-07-27\)/);
  assert.match(cicdProductionPlan, /PD-1 \(superseded 2026-07-27\)/);
  assert.match(cicdProductionPlan, /`\/headphones` → `200`; `\/overstock` → `404`/);
  assert.doesNotMatch(deploySource, /retired \/headphones and \/overstock storefronts/);
  assert.match(phase8TestPlan, /Status: completed; route contract superseded 2026-07-27/);
  assert.match(phase8TestPlan, /`\/headphones` returns HTTP 200; `\/overstock` remains HTTP 404/);
  assert.doesNotMatch(phase8TestPlan, /Both hidden paths remain HTTP 404/);
  assert.match(phase8Mius, /Status: completed and delivered; route contract superseded 2026-07-27/);
  assert.match(phase8Architecture, /Route contract superseded 2026-07-27/);
  assert.match(oemRefreshDesign, /Route contract superseded 2026-07-27/);
  assert.match(oemExecution, /Route contract superseded 2026-07-27/);

  for (const contract of [
    '`passwordResets`',
    '`rateLimitHits`',
    '`passwordResets.expiresAt`',
    '`passwordResets.tokenHash` (unique)',
    '`rateLimitHits.createdAt`',
    '`rateLimitHits.scope + rateLimitHits.createdAt`',
    '`rateLimitHits.scope + rateLimitHits.sourceHash + rateLimitHits.createdAt`',
    '`ADMINONLY`',
    '`scripts/cloudbase-nosql-resources.mjs`',
  ]) {
    assert.ok(deploymentDesign.includes(contract), `deployment design keeps ${contract}`);
  }
});
