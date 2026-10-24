import { createCloudbaseHostingProvider } from '../release/hosting-provider.mjs';
import { assertHostingPath, identity } from '../release/input.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
export const dummyCollections = Object.freeze(
  [
    'Users',
    'Drafts',
    'Media',
    'Publications',
    'Slugs',
    'Tasks',
    'Heads',
    'Accepted',
    'ReleaseTargets',
    'ReleaseScopes',
    'ReleaseRuns',
    'ReleaseSteps',
  ].map((name) => `blogDummy20261023${name}`),
);
export function createBlogDummyProvider(manager) {
  const provider = createCloudbaseHostingProvider({
    manager,
    target: { envId: policy.envId, site: policy.siteOrigin },
  });
  const environment = manager.currentEnvironment();
  function only(path) {
    assertHostingPath(path);
    if (!path.startsWith(policy.canaryPrefix))
      throw new Error('Attempted write outside dummy prefix');
  }
  return {
    ...provider,
    upload: (path, bytes, options) => {
      only(path);
      return provider.upload(path, bytes, options);
    },
    remove: (path, options) => {
      only(path);
      return provider.remove(path, options);
    },
    configure: async () => {
      throw new Error('Dummy cannot change website or gateway configuration');
    },
    async inventory(prefix) {
      if (prefix !== policy.canaryPrefix) throw new Error('Invalid dummy inventory prefix');
      const result = await environment.getHostingService().findFiles({ prefix, maxKeys: 1000 });
      if (
        result.Prefix !== prefix ||
        !Array.isArray(result.Contents) ||
        ![false, 'false'].includes(result.IsTruncated) ||
        result.Contents.length > 512
      )
        throw new Error('Dummy inventory is incomplete');
      const paths = result.Contents.map((item) => {
        only(item.Key);
        return item.Key;
      });
      if (new Set(paths).size !== paths.length) throw new Error('Duplicate dummy paths');
      return paths;
    },
    async permissions(expectedHash) {
      for (const name of dummyCollections)
        if ((await manager.database.checkCollectionExists(name)).Exists !== true)
          throw new Error('Dummy resources are not prepared');
      const result = await manager.permission.describeResourcePermission({
        resourceType: 'collection',
        resources: dummyCollections,
      });
      const list = result.Data?.PermissionList;
      if (
        !Array.isArray(list) ||
        list.length !== dummyCollections.length ||
        result.Data.TotalCount !== dummyCollections.length ||
        dummyCollections.some(
          (name) =>
            list.filter((item) => item.Resource === name && item.Permission === 'ADMINONLY')
              .length !== 1,
        )
      )
        throw new Error('Dummy collections are not all server-only');
      const opa = [];
      for (const key of ['authz.platform.extension.rego', 'authz.user.rego']) {
        const result = await manager.permission.describeEnvAuthzConfig({ key });
        if (
          !result.Item ||
          typeof result.Item.Value !== 'string' ||
          (result.Item.Key !== key && !(result.Item.Key === '' && result.Item.Value === ''))
        )
          throw new Error('Dummy authorization policy could not be read');
        opa.push({ key, item: result.Item });
      }
      const hash = identity({
        collections: [...list].sort((a, b) => a.Resource.localeCompare(b.Resource)),
        opa,
      });
      if (expectedHash && hash !== expectedHash)
        throw new Error('Dummy permissions changed after review');
      return hash;
    },
  };
}
