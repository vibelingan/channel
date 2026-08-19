export const REQUIRED_NOSQL_RESOURCES = [
  {
    collectionName: 'passwordResets',
    permission: 'ADMINONLY',
    indexes: [
      index('password_reset_expires_at', [['expiresAt', '1']]),
      index('password_reset_token_hash', [['tokenHash', '1']], true),
    ],
  },
  {
    collectionName: 'rateLimitHits',
    permission: 'ADMINONLY',
    indexes: [
      index('rate_limit_created_at', [['createdAt', '1']]),
      index('rate_limit_scope_created_at', [
        ['scope', '1'],
        ['createdAt', '1'],
      ]),
      index('rate_limit_scope_source_created_at', [
        ['scope', '1'],
        ['sourceHash', '1'],
        ['createdAt', '1'],
      ]),
    ],
  },
  // Catalog product identity uniqueness + mutation serialization. Both are
  // function-only coordination state and never client-readable.
  {
    collectionName: 'catalogProductIdentities',
    permission: 'ADMINONLY',
    indexes: [],
  },
  {
    collectionName: 'catalogProductMutationLocks',
    permission: 'ADMINONLY',
    indexes: [],
  },
  // Alibaba linked catalog sync (docs/alibaba-linked-catalog-sync/, MIU 3).
  // All ADMINONLY: every read/write goes through the functions, never the
  // client SDK. Deterministic document ids (sourceKey/offerKey/connectionId)
  // provide uniqueness without extra unique indexes.
  {
    collectionName: 'alibabaConnections',
    permission: 'ADMINONLY',
    indexes: [],
  },
  {
    collectionName: 'alibabaOAuthStates',
    permission: 'ADMINONLY',
    indexes: [index('alibaba_oauth_state_expires_at', [['expiresAt', '1']])],
  },
  {
    collectionName: 'alibabaSyncLeases',
    permission: 'ADMINONLY',
    indexes: [],
  },
  {
    collectionName: 'alibabaSyncCheckpoints',
    permission: 'ADMINONLY',
    indexes: [],
  },
  {
    collectionName: 'alibabaSourcePayloads',
    permission: 'ADMINONLY',
    indexes: [
      index('alibaba_payload_response_sha256', [['responseSha256', '1']]),
      index('alibaba_payload_run', [['runId', '1']]),
    ],
  },
  {
    collectionName: 'alibabaSourceProducts',
    permission: 'ADMINONLY',
    indexes: [
      index('alibaba_source_connection_active', [
        ['connectionId', '1'],
        ['active', '1'],
      ]),
      index('alibaba_source_last_seen_run', [['lastSeenRunId', '1']]),
    ],
  },
  {
    collectionName: 'alibabaProductLinks',
    permission: 'ADMINONLY',
    indexes: [index('alibaba_link_product', [['productId', '1']])],
  },
  {
    collectionName: 'alibabaSupplierOffers',
    permission: 'ADMINONLY',
    indexes: [
      index('alibaba_offer_source_key', [['sourceKey', '1']]),
      index('alibaba_offer_connection_active', [
        ['connectionId', '1'],
        ['active', '1'],
      ]),
    ],
  },
  {
    collectionName: 'alibabaSyncRuns',
    permission: 'ADMINONLY',
    indexes: [
      index('alibaba_run_connection_started', [
        ['connectionId', '1'],
        ['startedAt', '-1'],
      ]),
      index('alibaba_run_status', [['status', '1']]),
    ],
  },
  {
    collectionName: 'alibabaCategoryMappings',
    permission: 'ADMINONLY',
    indexes: [index('alibaba_category_mapping_source', [['alibabaCategoryId', '1']], true)],
  },
];

function index(IndexName, keys, MgoIsUnique = false) {
  return {
    IndexName,
    MgoKeySchema: {
      MgoIsUnique,
      MgoIndexKeys: keys.map(([Name, Direction]) => ({ Name, Direction })),
    },
  };
}

function assertSucceeded(result, label) {
  if (!result || typeof result !== 'object' || result.success === false) {
    const message = result?.message ? `: ${result.message}` : '';
    throw new Error(`${label} failed${message}`);
  }
  return result;
}

function exists(result) {
  return result?.exists === true || result?.data?.exists === true;
}

function permission(result) {
  return result?.data?.aclTag ?? result?.aclTag ?? '';
}

function indexNames(result) {
  const indexes = result?.indexes ?? result?.data?.indexes ?? [];
  return new Map(indexes.map((candidate) => [candidate?.Name, indexSignature(candidate)]));
}

function indexSignature(candidate) {
  const unique = candidate?.Unique ?? candidate?.MgoKeySchema?.MgoIsUnique ?? false;
  const keys = candidate?.Keys ?? candidate?.MgoKeySchema?.MgoIndexKeys ?? [];
  return JSON.stringify({
    unique,
    keys: keys.map(({ Name, Direction }) => ({ Name, Direction: String(Direction) })),
  });
}

export function ensureNoSqlResources(callTool, log = console.log) {
  for (const resource of REQUIRED_NOSQL_RESOURCES) {
    const { collectionName, indexes, permission: requiredPermission } = resource;
    const collection = assertSucceeded(
      callTool('cloudbase.readNoSqlDatabaseStructure', {
        action: 'checkCollection',
        collectionName,
      }),
      `${collectionName}: check collection`,
    );

    if (!exists(collection)) {
      assertSucceeded(
        callTool('cloudbase.writeNoSqlDatabaseStructure', {
          action: 'createCollection',
          collectionName,
        }),
        `${collectionName}: create collection`,
      );
    }

    const currentIndexes = assertSucceeded(
      callTool('cloudbase.readNoSqlDatabaseStructure', {
        action: 'listIndexes',
        collectionName,
      }),
      `${collectionName}: list indexes`,
    );
    const existingIndexNames = indexNames(currentIndexes);
    const missingIndexes = [];
    for (const requiredIndex of indexes) {
      const actualSignature = existingIndexNames.get(requiredIndex.IndexName);
      if (actualSignature === undefined) {
        missingIndexes.push(requiredIndex);
        continue;
      }
      const expectedSignature = indexSignature(requiredIndex);
      if (actualSignature !== expectedSignature) {
        throw new Error(
          `${collectionName}: index ${requiredIndex.IndexName} definition drift; expected ${expectedSignature}, got ${actualSignature}. Refusing to replace an existing index automatically.`,
        );
      }
    }

    if (missingIndexes.length > 0) {
      assertSucceeded(
        callTool('cloudbase.writeNoSqlDatabaseStructure', {
          action: 'updateCollection',
          collectionName,
          updateOptions: { CreateIndexes: missingIndexes },
        }),
        `${collectionName}: create indexes`,
      );
    }

    const currentPermission = assertSucceeded(
      callTool('cloudbase.queryPermissions', {
        action: 'getResourcePermission',
        resourceType: 'noSqlDatabase',
        resourceId: collectionName,
      }),
      `${collectionName}: query permission`,
    );
    if (permission(currentPermission) !== requiredPermission) {
      assertSucceeded(
        callTool('cloudbase.managePermissions', {
          action: 'updateResourcePermission',
          resourceType: 'noSqlDatabase',
          resourceId: collectionName,
          permission: requiredPermission,
        }),
        `${collectionName}: set ${requiredPermission} permission`,
      );
    }

    const verifiedCollection = assertSucceeded(
      callTool('cloudbase.readNoSqlDatabaseStructure', {
        action: 'checkCollection',
        collectionName,
      }),
      `${collectionName}: verify collection`,
    );
    if (!exists(verifiedCollection)) {
      throw new Error(`${collectionName}: collection is still missing after provisioning`);
    }

    const verifiedIndexes = assertSucceeded(
      callTool('cloudbase.readNoSqlDatabaseStructure', {
        action: 'listIndexes',
        collectionName,
      }),
      `${collectionName}: verify indexes`,
    );
    const verifiedIndexNames = indexNames(verifiedIndexes);
    for (const requiredIndex of indexes) {
      if (verifiedIndexNames.get(requiredIndex.IndexName) !== indexSignature(requiredIndex)) {
        throw new Error(
          `${collectionName}: index ${requiredIndex.IndexName} still has the wrong definition after provisioning`,
        );
      }
    }

    const verifiedPermission = assertSucceeded(
      callTool('cloudbase.queryPermissions', {
        action: 'getResourcePermission',
        resourceType: 'noSqlDatabase',
        resourceId: collectionName,
      }),
      `${collectionName}: verify permission`,
    );
    if (permission(verifiedPermission) !== requiredPermission) {
      throw new Error(
        `${collectionName}: expected ${requiredPermission} permission after provisioning`,
      );
    }

    log(`${collectionName}: ready (${indexes.length} indexes, ${requiredPermission})`);
  }
}
