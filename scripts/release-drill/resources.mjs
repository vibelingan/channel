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
  const report = [];
  for (const name of drillCollections) {
    const before = await manager.database.checkCollectionExists(name);
    if (typeof before.Exists !== 'boolean') throw Error('Dummy collection inventory unconfirmed');
    if (!before.Exists) {
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
    report.push({ name, created: !before.Exists, permission: 'ADMINONLY' });
  }
  return report;
}
