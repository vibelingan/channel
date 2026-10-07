/**
 * Manual products become approved versions like synced ones (DEC-4, MIU-27).
 * A manual product has no supplier observation, so its "candidate" is an empty
 * header; the approval planner fills name, photos, description and the website
 * price from the row, and the specification facts from the row's spec fields.
 */
const FACTS = [
  ['skuCode', 'SKU'],
  ['series', 'Series'],
  ['modName', 'Model'],
  ['modType', 'Type'],
] as const;

/** Spec facts with the labels the legacy product page used; empty values dropped. */
export function manualFacts(product: Record<string, unknown>): { name: string; value: string }[] {
  return FACTS.flatMap(([field, name]) => {
    const value = product[field];
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? [{ name, value: text }] : [];
  });
}

export function manualDetailCandidate(product: { _id: string; name: string }) {
  return {
    schemaVersion: 'catalog-product-detail-v1' as const,
    _id: product._id,
    name: product.name,
    images: [] as string[],
    facts: [] as { name: string; value: string }[],
    offers: [] as never[],
  };
}
