export interface ProductSubcategoryQueryCommand {
  and(conditions: Record<string, unknown>[]): Record<string, unknown>;
  or(conditions: Record<string, unknown>[]): Record<string, unknown>;
  exists(value: boolean): unknown;
  eq(value: unknown): unknown;
  in(values: unknown[]): unknown;
  expr(expression: Record<string, unknown>): Record<string, unknown>;
}

const families = ['headphones', 'ai-gadgets', 'toys', 'misc'];
const legacyCategories = ['wired', 'office', 'bluetooth'];

function validIds(value: unknown, maximum: number): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return false;
  const seen = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 80 ||
      !/^[a-z0-9]/.test(id) ||
      /[^a-z0-9_-]/.test(id) ||
      seen.has(id)
    ) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

export function productSubcategoryWhere(
  command: ProductSubcategoryQueryCommand,
  input: unknown,
): Record<string, unknown> {
  const noMatch = () => ({ _id: command.exists(false) });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return noMatch();
  const { family, ids, knownIds } = input as Record<string, unknown>;
  if (
    typeof family !== 'string' ||
    !families.includes(family) ||
    !validIds(ids, 16) ||
    !validIds(knownIds, 64) ||
    !ids.every((id) => knownIds.includes(id))
  ) {
    return noMatch();
  }

  const scalarCategory = command.expr({ $eq: [{ $isArray: '$category' }, false] });
  const familyWhere =
    family === 'headphones'
      ? command.or([
          { productFamily: command.eq(family) },
          command.and([
            { productFamily: command.exists(false) },
            { category: command.in([...legacyCategories]) },
            scalarCategory,
          ]),
        ])
      : command.and([
          { productFamily: command.eq(family) },
          command.or([{ category: command.exists(false) }, { category: command.eq('') }]),
          scalarCategory,
        ]);
  const arrayWhere = command.expr({
    $cond: [
      { $isArray: '$subcategoryIds' },
      {
        $and: [
          { $lte: [{ $size: '$subcategoryIds' }, 16] },
          {
            $eq: [{ $size: '$subcategoryIds' }, { $size: { $setUnion: ['$subcategoryIds', []] } }],
          },
          { $setIsSubset: ['$subcategoryIds', [...knownIds]] },
          { $gt: [{ $size: { $setIntersection: ['$subcategoryIds', [...ids]] } }, 0] },
        ],
      },
      false,
    ],
  });
  const selectedLegacyCategories =
    family === 'headphones'
      ? legacyCategories.filter((category) => ids.includes(`headphones-${category}`))
      : [];
  const assignmentWhere =
    selectedLegacyCategories.length > 0
      ? command.or([
          arrayWhere,
          command.and([
            { subcategoryIds: command.exists(false) },
            { category: command.in(selectedLegacyCategories) },
            scalarCategory,
          ]),
        ])
      : arrayWhere;
  return command.and([
    familyWhere,
    assignmentWhere,
    command.expr({ $eq: [{ $isArray: '$productFamily' }, false] }),
  ]);
}
