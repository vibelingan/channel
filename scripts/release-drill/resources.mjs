export const drillCollections = Object.freeze([
  'seoReleaseDrillFixtures',
  'seoReleaseDrillTargets',
  'seoReleaseDrillScopes',
  'seoReleaseDrillRuns',
  'seoReleaseDrillSteps',
]);

/** Provision only missing, fixed test collections; never reset an existing permission or data. */
export async function ensureDummyResources(manager) {
  const environment = manager.currentEnvironment();
  await environment.lazyInit();
  if (
    environment.getEnvId() !== 'diversity-123-d9grnqfux221323bb' ||
    manager.getManagerConfig().envId !== environment.getEnvId() ||
    manager.getManagerConfig().region !== 'ap-shanghai'
  )
    throw Error('Dummy resource target differs');
  const inventory = await manager.database.listCollections({ MgoLimit: 100, MgoOffset: 0 });
  if (
    !Array.isArray(inventory.Collections) ||
    inventory.Pager?.Offset !== 0 ||
    inventory.Pager.Total !== inventory.Collections.length ||
    inventory.Collections.length > 100 ||
    inventory.Collections.some((row) => typeof row.CollectionName !== 'string')
  )
    throw Error('Complete dummy collection inventory required');
  const names = new Set(inventory.Collections.map((row) => row.CollectionName));
  const report = [];
  for (const name of drillCollections) {
    const existed = names.has(name);
    if (!existed) {
      await manager.database.createCollection(name);
      await manager.permission.modifyResourcePermission({
        resourceType: 'collection',
        resource: name,
        permission: 'ADMINONLY',
      });
    }
    const permission = await manager.permission.describeResourcePermission({
      resourceType: 'collection',
      resources: [name],
    });
    const rows = permission.Data?.PermissionList;
    if (
      permission.Data?.TotalCount !== 1 ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0].Resource !== name ||
      rows[0].Permission !== 'ADMINONLY'
    )
      throw Error('Dummy collection is not confirmed private');
    report.push({ name, created: !existed, permission: 'ADMINONLY' });
  }
  return report;
}

/** New journals cannot be read until their private collections exist. */
export async function prepareDummyInitialization(manager, coordinator) {
  const functions = await manager.functions.listFunctions(100, 0);
  if (
    !Array.isArray(functions) ||
    functions.length >= 100 ||
    functions.some((row) => row.FunctionName === 'seo-release-dummy')
  )
    throw Error('The temporary function name is occupied or its inventory is incomplete');
  const resources = await ensureDummyResources(manager);
  if ((await coordinator.status()).state !== 'uninitialized')
    throw Error('An earlier drill exists; inspect it before initializing');
  return resources;
}
