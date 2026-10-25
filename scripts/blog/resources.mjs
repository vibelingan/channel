import { ARTICLE_NOSQL_RESOURCES } from '../blog-article-resources.mjs';
import { identity } from '../release/input.mjs';

const signature = (value) =>
  identity({
    unique: value.Unique ?? value.MgoKeySchema?.MgoIsUnique ?? false,
    keys: (value.Keys ?? value.MgoKeySchema?.MgoIndexKeys ?? []).map(({ Name, Direction }) => ({
      Name,
      Direction: String(Direction),
    })),
  });
/** Module-owned metadata only. No record deletion, schema rollback or environment-policy replacement. */
export async function ensureFormalArticleResources({
  manager,
  envId,
  now = Date.now,
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  const environment = manager.currentEnvironment();
  await environment.lazyInit();
  if (
    envId !== manager.getManagerConfig().envId ||
    environment.getEnvId() !== envId ||
    environment.lazyEnvironmentConfig?.EnvId !== envId
  )
    throw new Error('Article resource environment differs');
  const report = [];
  for (const resource of ARTICLE_NOSQL_RESOURCES) {
    const name = resource.collectionName;
    let detail;
    try {
      detail = await manager.database.describeCollection(name);
    } catch (error) {
      if (error.code !== 'ResourceNotFound') throw error;
    }
    if (!detail) {
      await manager.database.createCollection(name);
      detail = await manager.database.describeCollection(name);
    }
    if (!Array.isArray(detail.Indexes)) throw new Error('Collection index inventory is incomplete');
    const missing = [];
    for (const index of resource.indexes) {
      const old = detail.Indexes.find((item) => item.Name === index.IndexName);
      if (old && signature(old) !== signature(index))
        throw new Error('Existing article index has another definition');
      if (!old) missing.push(index);
    }
    if (missing.length) {
      await manager.database.updateCollection(name, { CreateIndexes: missing });
      const deadline = now() + 120000;
      for (;;) {
        detail = await manager.database.describeCollection(name);
        if (
          Array.isArray(detail.Indexes) &&
          resource.indexes.every((index) =>
            detail.Indexes.some(
              (item) => item.Name === index.IndexName && signature(item) === signature(index),
            ),
          )
        )
          break;
        if (now() >= deadline) throw new Error('Article index creation was not confirmed');
        await pause(1000);
      }
    }
    const readPermission = async () => {
      const value = await manager.permission.describeResourcePermission({
        resourceType: 'collection',
        resources: [name],
      });
      const rows = value.Data?.PermissionList;
      if (
        !Array.isArray(rows) ||
        value.Data.TotalCount !== 1 ||
        rows.length !== 1 ||
        rows[0].Resource !== name
      )
        throw new Error('Article permission readback is incomplete');
      return rows[0].Permission;
    };
    if ((await readPermission()) !== 'ADMINONLY')
      await manager.permission.modifyResourcePermission({
        resourceType: 'collection',
        resource: name,
        permission: 'ADMINONLY',
      });
    if ((await readPermission()) !== 'ADMINONLY')
      throw new Error('Article collection is not server-only');
    report.push({
      name,
      permission: 'ADMINONLY',
      indexes: resource.indexes.map((i) => i.IndexName),
    });
  }
  return report;
}
