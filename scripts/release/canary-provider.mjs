import { createCloudbaseHostingProvider } from './hosting-provider.mjs';
import { identity, isHash } from './input.mjs';
import { tables } from './ledger.mjs';

/** Additional read-only checks; this adapter never provisions collections or modifies permissions. */
export function createCanaryProvider({ manager, policy }) {
  const target = { envId: policy.envId, site: policy.siteOrigin };
  const provider = createCloudbaseHostingProvider({ manager, target });
  const environment = manager.currentEnvironment();
  const bound = async () => {
    await environment.lazyInit();
    if (
      manager.cloudBaseConfig.envId !== target.envId ||
      environment.getEnvId() !== target.envId ||
      environment.lazyEnvironmentConfig?.EnvId !== target.envId
    )
      throw new Error('Canary environment mismatch');
  };
  return Object.freeze({
    ...provider,
    async inventory(prefix) {
      if (prefix !== policy.canaryPrefix) throw new Error('Inventory prefix mismatch');
      await bound();
      const page = await environment.getHostingService().findFiles({ prefix, maxKeys: 2 });
      if (
        page.Prefix !== prefix ||
        !Array.isArray(page.Contents) ||
        ![false, 'false'].includes(page.IsTruncated) ||
        page.Contents.length > 1 ||
        page.Contents.some((x) => typeof x.Key !== 'string' || !x.Key.startsWith(prefix))
      )
        throw new Error('Unproven exclusive canary prefix inventory');
      return page.Contents.map((x) => x.Key);
    },
    async controlPlane({ execute = false } = {}) {
      await bound();
      const names = Object.values(tables);
      for (const name of names) {
        const result = await manager.database.checkCollectionExists(name);
        if (result.Exists !== true)
          throw new Error('Release control collections require separate reviewed provisioning');
      }
      const permissions = await manager.permission.describeResourcePermission({
        resourceType: 'collection',
        resources: names,
      });
      const list = permissions.Data?.PermissionList;
      if (
        permissions.Data?.TotalCount !== 4 ||
        !Array.isArray(list) ||
        list.length !== 4 ||
        names.some(
          (name) =>
            list.filter((x) => x.Resource === name && x.Permission === 'ADMINONLY').length !== 1,
        )
      )
        throw new Error('Release control collections are not proven server-only');
      const opa = [];
      for (const key of ['authz.platform.extension.rego', 'authz.user.rego']) {
        const result = await manager.permission.describeEnvAuthzConfig({ key });
        if (result.Data?.Key !== key || typeof result.Data.Value !== 'string')
          throw new Error('Unproven environment authorization configuration');
        opa.push({ key, data: result.Data });
      }
      const securityReviewSha256 = identity({
        permissions: {
          ...permissions.Data,
          PermissionList: [...list].sort((a, b) => a.Resource.localeCompare(b.Resource)),
        },
        opa,
      });
      // Legacy ADMINONLY cannot alone prove effective permissions under OPA. Enablement pins a reviewed complete response.
      if (
        execute &&
        (!isHash(policy.controlPlaneReviewSha256) ||
          securityReviewSha256 !== policy.controlPlaneReviewSha256)
      )
        throw new Error('Control-plane access review is missing or changed');
      return { securityReviewSha256, collections: names };
    },
  });
}
