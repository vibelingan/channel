import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PRODUCT_FAMILY_OPTIONS,
  productFamilyForDoc,
} from '../packages/shared/src/catalog-product.ts';
import {
  CatalogTaxonomySchema,
  initialCatalogTaxonomy,
  readProductSubcategories,
  validateProductSubcategories,
} from '../packages/shared/src/catalog-taxonomy.ts';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validProductId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value
  );
}

export function planCatalogTaxonomyMigration(snapshot) {
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.products) ||
    Object.keys(snapshot).some((key) => !['products', 'catalogTaxonomies'].includes(key)) ||
    (Object.hasOwn(snapshot, 'catalogTaxonomies') && !Array.isArray(snapshot.catalogTaxonomies))
  )
    throw new Error('Expected { products: [...], catalogTaxonomies?: [...] } only.');

  const registries = new Map();
  for (const raw of snapshot.catalogTaxonomies ?? []) {
    if (!isRecord(raw)) throw new Error('Invalid exported taxonomy.');
    const parsed = CatalogTaxonomySchema.safeParse({
      family: raw.family,
      revision: raw.revision,
      name: raw.name,
      children: raw.children,
    });
    if (
      !parsed.success ||
      (Object.hasOwn(raw, '_id') && raw._id !== parsed.data.family) ||
      registries.has(parsed.data.family)
    )
      throw new Error('Invalid or duplicate exported taxonomy.');
    registries.set(parsed.data.family, parsed.data);
  }
  const defaultTaxonomyFamilies = PRODUCT_FAMILY_OPTIONS.filter(
    (family) => !registries.has(family),
  );
  for (const family of defaultTaxonomyFamilies)
    registries.set(family, initialCatalogTaxonomy(family));

  const idCounts = new Map();
  for (const product of snapshot.products) {
    if (isRecord(product) && validProductId(product._id)) {
      idCounts.set(product._id, (idCounts.get(product._id) ?? 0) + 1);
    }
  }
  const products = snapshot.products.map((product, index) => {
    const productId = isRecord(product) && validProductId(product._id) ? product._id : null;
    const family = isRecord(product) ? productFamilyForDoc(product) : null;
    const entry = { index, productId, family };
    if (!productId || idCounts.get(productId) !== 1) {
      return { ...entry, status: 'unresolved', reason: 'invalid-or-duplicate-product-id' };
    }
    if (!family) return { ...entry, status: 'unresolved', reason: 'invalid-family' };
    const registry = registries.get(family);
    const classification = readProductSubcategories(product, registry);
    if (classification.status === 'invalid') {
      return { ...entry, status: 'unresolved', reason: 'invalid-classification' };
    }
    if (classification.source === 'legacy') {
      if (!validateProductSubcategories(family, classification.subcategoryIds, registry)) {
        return { ...entry, status: 'unresolved', reason: 'inactive-legacy-target' };
      }
      return {
        ...entry,
        status: 'legacy-absent',
        proposedSubcategoryIds: classification.subcategoryIds,
      };
    }
    if (classification.source === 'assigned') {
      return {
        ...entry,
        status:
          classification.subcategoryIds.length === 0
            ? 'preserved-explicit-empty'
            : 'preserved-assigned',
        subcategoryIds: classification.subcategoryIds,
      };
    }
    return { ...entry, status: 'unassigned' };
  });
  const summary = {
    total: products.length,
    'legacy-absent': 0,
    'preserved-explicit-empty': 0,
    'preserved-assigned': 0,
    unassigned: 0,
    unresolved: 0,
  };
  for (const product of products) summary[product.status] += 1;
  return { mode: 'dry-run', writes: 0, defaultTaxonomyFamilies, summary, products };
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  const usage =
    'node --experimental-strip-types scripts/catalog-taxonomy-migration.mjs --input /local/export.json [--dry-run]';
  if (values.help) {
    console.log(
      `${usage}\nInput: { products: [...], catalogTaxonomies?: [...] }. Dry-run only; no write mode.`,
    );
    return;
  }
  if (!values.input) throw new Error(`A local JSON export is required. Usage: ${usage}`);
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(resolve(values.input), 'utf8'));
  } catch {
    throw new Error('Unable to read the supplied local JSON export.');
  }
  console.log(JSON.stringify(planCatalogTaxonomyMigration(snapshot), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to generate migration report.');
    process.exitCode = 1;
  }
}
