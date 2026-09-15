/** Read-only audit of already collected data. Never infer taxonomy from titles. */
import { validateCatalogSourceObservation } from './source-observations.ts';

export interface SourceCategoryCoverage {
  provider: string;
  sourceTaxonomy: string | null;
  sourceCategoryId: string | null;
  sourceCategoryNames: string[];
  productCount: number;
  variantCount: number;
  exampleTitles: string[];
}

/**
 * Accepts observations, not database envelopes or raw vendor responses.
 * Invalid records and duplicate product identities remain visible in findings;
 * they cannot silently inflate or disappear from the reported coverage.
 */
export function auditSourceCategoryCoverage(inputs: readonly unknown[]) {
  const groups = new Map<string, SourceCategoryCoverage>();
  const identities = new Set<string>();
  const findings: Array<{ index: number; code: string; errors: string[] }> = [];
  let validProducts = 0;
  let missingCategoryIds = 0;
  for (const [index, input] of inputs.entries()) {
    const validated = validateCatalogSourceObservation(input);
    if (!validated.ok) {
      findings.push({ index, code: 'invalid-observation', errors: validated.errors });
      continue;
    }
    const observation = validated.value;
    const identity = JSON.stringify([
      observation.source.provider,
      observation.source.sourceProductKey,
    ]);
    if (identities.has(identity)) {
      findings.push({ index, code: 'duplicate-product-identity', errors: [] });
      continue;
    }
    identities.add(identity);
    validProducts += 1;
    const category = observation.identity.category;
    if (!category?.sourceCategoryId) missingCategoryIds += 1;
    // No magic sentinel strings: a genuine category named "unclassified" or
    // "__proto__" must remain distinct from a missing category.
    const key = JSON.stringify([
      observation.source.provider,
      category?.sourceTaxonomy ?? null,
      category?.sourceCategoryId ?? null,
    ]);
    const group = groups.get(key) ?? {
      provider: observation.source.provider,
      sourceTaxonomy: category?.sourceTaxonomy ?? null,
      sourceCategoryId: category?.sourceCategoryId ?? null,
      sourceCategoryNames: [],
      productCount: 0,
      variantCount: 0,
      exampleTitles: [],
    };
    group.productCount += 1;
    group.variantCount += observation.variants.length;
    const name = category?.sourceCategoryName;
    if (name && !group.sourceCategoryNames.includes(name)) group.sourceCategoryNames.push(name);
    const title = observation.identity.title;
    if (title && group.exampleTitles.length < 5 && !group.exampleTitles.includes(title)) {
      group.exampleTitles.push(title);
    }
    groups.set(key, group);
  }
  const categories = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => ({ ...group, sourceCategoryNames: group.sourceCategoryNames.sort() }));
  return { inputCount: inputs.length, validProducts, missingCategoryIds, categories, findings };
}
