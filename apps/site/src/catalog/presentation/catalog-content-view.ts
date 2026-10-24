import type {
  CatalogContent,
  CatalogProductDetail,
} from '@vibelingan-channel/shared/catalog-detail';

/** Merge approved text fields only. Conflicting labels remain visible as notes,
 * but cannot become headline facts. No provider parsing or category inference. */
export function catalogContentView(facts: CatalogProductDetail['facts'], content?: CatalogContent) {
  const key = (name: string) =>
    name
      .toLowerCase()
      .replace(/[\s:]+/g, ' ')
      .trim();
  const rows = [...facts, ...(content?.specifications ?? [])];
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = key(row.name);
    const group = groups.get(id) ?? [];
    if (!group.some((existing) => existing.value === row.value)) group.push(row);
    groups.set(id, group);
  }
  const specifications: typeof rows = [];
  const notes = [...(content?.notes ?? [])];
  for (const group of groups.values()) {
    if (group.length === 1 && group[0]) specifications.push(group[0]);
    else notes.push(...group.map((row) => `${row.name} — ${row.value}`));
  }
  // Avoid SKU-dependent claims (microphone/connectivity/etc.) in the summary.
  const headlineNames = new Set([
    'material',
    'drivers size',
    'driver size',
    'frequency response',
    'impedance',
    'weight',
    'dimensions',
  ]);
  const highlights = specifications
    .filter((row) => headlineNames.has(key(row.name)) && row.value.length <= 80)
    .slice(0, 3);
  return { specifications, packaging: content?.packaging ?? [], notes, highlights };
}
