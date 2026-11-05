import { CATALOG_SEO_NOSQL_RESOURCES } from '../catalog-seo-resources.mjs';
import { REQUIRED_NOSQL_RESOURCES } from '../cloudbase-nosql-resources.mjs';
import { identity } from './input.mjs';
const indexNames = ['approved_variant_id', 'variant_product_id', 'product_family_id'];
/**
 * Prepare only the declared private SEO collections and additive read indexes.
 * @param {any} manager
 * @param {(progress: {createdCollections: string[], verifiedCollections: string[], createdIndexes: {collection: string, name: string}[], businessWrites: number, deletedResources: number}) => Promise<void>} onProgress
 */
export async function prepareCatalogResources(manager, onProgress = async (_progress) => {}) {
  const existing = await collectionInventory(manager);
  const result = {
    createdCollections: [],
    verifiedCollections: [],
    createdIndexes: [],
    businessWrites: 0,
    deletedResources: 0,
  };
  const checkIndex = async (collection, spec) => {
    const find = async () => {
      const detail = await manager.database.describeCollection(collection);
      if (!Array.isArray(detail.Indexes)) throw Error('Index inventory missing');
      const matches = detail.Indexes.filter((i) => i.Name === spec.IndexName);
      if (matches.length > 1) throw Error('Duplicate required index');
      const row = matches[0];
      if (
        row &&
        (row.Unique !== spec.MgoKeySchema.MgoIsUnique ||
          identity(row.Keys) !== identity(spec.MgoKeySchema.MgoIndexKeys))
      )
        throw Error('Existing index differs; no index replaced or deleted');
      return row;
    };
    if (!(await find())) {
      await manager.database.updateCollection(collection, { CreateIndexes: [spec] });
      result.createdIndexes.push({ collection, name: spec.IndexName });
      await onProgress(result);
    }
    if (!(await find())) throw Error('Required index creation needs readback');
  };
  for (const spec of CATALOG_SEO_NOSQL_RESOURCES) {
    const name = spec.collectionName;
    if (!existing.has(name)) {
      await manager.database.createCollection(name);
      result.createdCollections.push(name);
      await onProgress(result);
      await manager.permission.modifyResourcePermission({
        resourceType: 'collection',
        resource: name,
        permission: 'ADMINONLY',
      });
    }
    const response = await manager.permission.describeResourcePermission({
      resourceType: 'collection',
      resources: [name],
    });
    const entries = response.Data?.PermissionList;
    if (
      !Array.isArray(entries) ||
      entries.filter((e) => e.Resource === name && e.Permission === 'ADMINONLY').length !== 1
    )
      throw Error(
        'SEO collection is not confirmed private; existing permissions were not rewritten',
      );
    for (const index of spec.indexes) await checkIndex(name, index);
    result.verifiedCollections.push(name);
    await onProgress(result);
  }
  for (const resource of REQUIRED_NOSQL_RESOURCES) {
    const indexes = resource.indexes.filter((i) => indexNames.includes(i.IndexName));
    if (!indexes.length) continue;
    if (!existing.has(resource.collectionName))
      throw Error('A required business collection is absent; no replacement collection created');
    for (const index of indexes) await checkIndex(resource.collectionName, index);
  }
  return result;
}

// checkCollectionExists swallows every SDK error; use a complete inventory so a timeout cannot authorize creation.
async function collectionInventory(manager) {
  const names = [];
  let total;
  for (let offset = 0; offset < 10000; offset += 100) {
    const response = await manager.database.listCollections({ MgoLimit: 100, MgoOffset: offset });
    if (
      !Array.isArray(response.Collections) ||
      response.Pager?.Offset !== offset ||
      !Number.isSafeInteger(response.Pager.Total) ||
      response.Pager.Total < 0 ||
      response.Pager.Total > 10000 ||
      (total !== undefined && total !== response.Pager.Total) ||
      response.Collections.length !== Math.min(100, response.Pager.Total - offset) ||
      response.Collections.some((row) => typeof row.CollectionName !== 'string')
    )
      throw Error('Complete resource inventory required before preparation');
    total = response.Pager.Total;
    names.push(...response.Collections.map((row) => row.CollectionName));
    if (names.length === total) {
      if (new Set(names).size !== names.length) throw Error('Duplicate resource inventory');
      return new Set(names);
    }
  }
  throw Error('Resource inventory exceeds its bound');
}
