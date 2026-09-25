import { z } from 'zod';
import {
  LEGACY_HEADPHONES_CATEGORY_OPTIONS,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  productFamilyForDoc,
} from './catalog-product.ts';

export const MAX_TAXONOMY_CHILDREN = 64;
export const MAX_PRODUCT_SUBCATEGORIES = 16;

const displayName = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value.trim() === value);
const childId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const assignmentIds = z
  .array(childId)
  .max(MAX_PRODUCT_SUBCATEGORIES)
  .refine((values) => new Set(values).size === values.length);

export const CatalogTaxonomySchema = z
  .object({
    family: z.enum(PRODUCT_FAMILY_OPTIONS),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    name: displayName,
    children: z
      .array(
        z
          .object({
            id: childId,
            name: displayName,
            slug: z
              .string()
              .min(1)
              .max(80)
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            order: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
            status: z.enum(['active', 'archived']),
          })
          .strict(),
      )
      .max(MAX_TAXONOMY_CHILDREN),
  })
  .strict()
  .superRefine((registry, context) => {
    for (const field of ['id', 'name', 'slug'] as const) {
      const values = registry.children.map((child) => child[field].normalize('NFKC').toLowerCase());
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['children'],
          message: `Duplicate child ${field}`,
        });
      }
    }
  });

export type CatalogTaxonomy = z.infer<typeof CatalogTaxonomySchema>;
const taxonomyFields = CatalogTaxonomySchema.innerType().shape;

export const CatalogTaxonomyCommandSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        kind: z.literal('taxonomy'),
        operation: z.literal('read'),
        family: taxonomyFields.family,
      })
      .strict(),
    z
      .object({
        kind: z.literal('taxonomy'),
        operation: z.literal('save'),
        family: taxonomyFields.family,
        expectedRevision: taxonomyFields.revision,
        name: taxonomyFields.name,
        children: taxonomyFields.children,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.operation !== 'save') return;
    const candidate = CatalogTaxonomySchema.safeParse({
      family: command.family,
      revision: command.expectedRevision,
      name: command.name,
      children: command.children,
    });
    if (!candidate.success) {
      for (const issue of candidate.error.issues) context.addIssue(issue);
    }
  });

export type CatalogTaxonomyCommand = z.infer<typeof CatalogTaxonomyCommandSchema>;

export const CatalogTaxonomyResultSchema = z.union([
  z
    .object({
      kind: z.literal('taxonomy'),
      status: z.enum(['configured', 'applied', 'replayed']),
      registry: CatalogTaxonomySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('taxonomy'),
      status: z.enum(['invalid', 'conflict', 'forbidden']),
    })
    .strict(),
]);

export type CatalogTaxonomyResult = z.infer<typeof CatalogTaxonomyResultSchema>;

export type ProductSubcategories =
  | { status: 'valid'; source: 'legacy' | 'assigned' | 'unassigned'; subcategoryIds: string[] }
  | { status: 'invalid' };

const familyNames: Record<ProductFamily, string> = {
  headphones: 'Headphones',
  'ai-gadgets': 'AI Gadgets',
  toys: 'Toys',
  misc: 'Miscellaneous',
};
const legacyNames = {
  wired: 'Wired Headphones',
  office: 'Office Headphones',
  bluetooth: 'Bluetooth Headphones',
};

export function initialCatalogTaxonomy(family: ProductFamily): CatalogTaxonomy {
  return {
    family,
    revision: 0,
    name: familyNames[family],
    children:
      family === 'headphones'
        ? LEGACY_HEADPHONES_CATEGORY_OPTIONS.map((category, order) => ({
            id: `headphones-${category}`,
            name: legacyNames[category],
            slug: category,
            order,
            status: 'active',
          }))
        : [],
  };
}

/** A missing row means the initial registry; unusable stored data returns null (fail closed). */
export function storedCatalogTaxonomy(
  family: ProductFamily,
  stored: Record<string, unknown> | null,
): CatalogTaxonomy | null {
  if (stored === null) return initialCatalogTaxonomy(family);
  if (stored._id !== family) return null;
  const parsed = CatalogTaxonomySchema.safeParse({
    family: stored.family,
    name: stored.name,
    revision: stored.revision,
    children: stored.children,
  });
  return parsed.success && parsed.data.family === family ? parsed.data : null;
}

export function validateProductSubcategories(
  family: ProductFamily,
  subcategoryIds: unknown,
  registry: CatalogTaxonomy,
  previousIds: readonly string[] = [],
): boolean {
  const parsedRegistry = CatalogTaxonomySchema.safeParse(registry);
  const parsedIds = assignmentIds.safeParse(subcategoryIds);
  if (!parsedRegistry.success || !parsedIds.success || parsedRegistry.data.family !== family)
    return false;
  return parsedIds.data.every((id) => {
    const child = parsedRegistry.data.children.find((candidate) => candidate.id === id);
    return child !== undefined && (child.status === 'active' || previousIds.includes(id));
  });
}

export function readProductSubcategories(
  product: Record<string, unknown>,
  registry: CatalogTaxonomy,
): ProductSubcategories {
  const family = productFamilyForDoc(product);
  if (!family || family !== registry.family || !CatalogTaxonomySchema.safeParse(registry).success) {
    return { status: 'invalid' };
  }
  if (family !== 'headphones' && product.category !== undefined && product.category !== '') {
    return { status: 'invalid' };
  }
  if (Object.hasOwn(product, 'subcategoryIds')) {
    const parsed = assignmentIds.safeParse(product.subcategoryIds);
    if (
      !parsed.success ||
      !validateProductSubcategories(family, parsed.data, registry, parsed.data)
    ) {
      return { status: 'invalid' };
    }
    return { status: 'valid', source: 'assigned', subcategoryIds: parsed.data };
  }
  if (product.category === undefined || product.category === '') {
    return { status: 'valid', source: 'unassigned', subcategoryIds: [] };
  }
  const legacy = LEGACY_HEADPHONES_CATEGORY_OPTIONS.find(
    (category) => category === product.category,
  );
  const id = legacy ? `headphones-${legacy}` : null;
  if (!id || !registry.children.some((child) => child.id === id)) return { status: 'invalid' };
  return { status: 'valid', source: 'legacy', subcategoryIds: [id] };
}

export const CatalogClassificationAssignmentRequestSchema = z
  .object({
    kind: z.literal('assignment'),
    operation: z.enum(['replace', 'append', 'clear']),
    family: taxonomyFields.family,
    taxonomyRevision: taxonomyFields.revision,
    products: z
      .array(
        z
          .object({
            productId: z
              .string()
              .min(1)
              .max(200)
              .refine((value) => value.trim() === value),
            expectedUpdatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .refine(
        (products) =>
          new Set(products.map((product) => product.productId)).size === products.length,
      ),
    subcategoryIds: assignmentIds,
    includeSavedRevision: z.literal(true).optional(),
  })
  .strict()
  .refine((command) => command.operation !== 'clear' || command.subcategoryIds.length === 0, {
    path: ['subcategoryIds'],
    message: 'Clear requires an empty subcategory list.',
  });

export type CatalogClassificationAssignmentRequest = z.infer<
  typeof CatalogClassificationAssignmentRequestSchema
>;

export const CatalogClassificationAssignmentResultSchema = z
  .object({
    kind: z.literal('assignment'),
    results: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(200),
            status: z.enum([
              'saved',
              'conflict',
              'invalid',
              'missing',
              'forbidden',
              'unknown',
              'notattempted',
            ]),
            updatedAt: z.string().datetime().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    refreshRequired: z.literal(true).optional(),
  })
  .strict();

export type CatalogClassificationAssignmentResult = z.infer<
  typeof CatalogClassificationAssignmentResultSchema
>;
