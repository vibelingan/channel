export const PRODUCT_FAMILY_OPTIONS = ['headphones', 'ai-gadgets', 'toys', 'misc'] as const;
export type ProductFamily = (typeof PRODUCT_FAMILY_OPTIONS)[number];

const PRODUCT_FAMILY_SET = new Set<string>(PRODUCT_FAMILY_OPTIONS);
export const LEGACY_HEADPHONES_CATEGORY_OPTIONS = ['wired', 'office', 'bluetooth'] as const;
const LEGACY_HEADPHONES_CATEGORIES = new Set<string>(LEGACY_HEADPHONES_CATEGORY_OPTIONS);
const RESERVED_PRODUCT_SLUGS = new Set([
  'account',
  'admin',
  'ai-gadgets',
  'api',
  'electronics-toys',
  'headphones',
  'login',
  'misc',
  'oem',
  'portfolio',
  'products',
  'register',
  'reset',
  'toys',
]);

export interface ProductPublicationIssue {
  field: 'name' | 'productFamily' | 'category' | 'description' | 'imageIds' | 'archived';
  message: string;
}

export function isProductFamily(value: unknown): value is ProductFamily {
  return typeof value === 'string' && PRODUCT_FAMILY_SET.has(value);
}

export type LegacyHeadphonesCategory = (typeof LEGACY_HEADPHONES_CATEGORY_OPTIONS)[number];

export function isLegacyHeadphonesCategory(value: unknown): value is LegacyHeadphonesCategory {
  return typeof value === 'string' && LEGACY_HEADPHONES_CATEGORIES.has(value);
}

export function normalizeProductSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!normalized || normalized.length > 120 || RESERVED_PRODUCT_SLUGS.has(normalized)) return null;
  return normalized;
}

export function normalizeSkuCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return normalized && normalized.length <= 120 ? normalized : null;
}

export function productFamilyForDoc(doc: Record<string, unknown>): ProductFamily | null {
  if (isProductFamily(doc.productFamily)) return doc.productFamily;
  if (Object.hasOwn(doc, 'productFamily')) return null;
  return typeof doc.category === 'string' && LEGACY_HEADPHONES_CATEGORIES.has(doc.category)
    ? 'headphones'
    : null;
}

export function validateProductPublication(
  values: Record<string, unknown>,
): ProductPublicationIssue[] {
  const issues: ProductPublicationIssue[] = [];
  if (
    isProductFamily(values.productFamily) &&
    values.productFamily !== 'headphones' &&
    typeof values.category === 'string' &&
    values.category.trim() !== ''
  ) {
    issues.push({ field: 'category', message: 'Subcategory applies only to Headphones' });
  }
  if (values.published !== true) return issues;
  if (typeof values.name !== 'string' || values.name.trim() === '') {
    issues.push({ field: 'name', message: 'Product name is required to publish' });
  }
  if (!isProductFamily(values.productFamily)) {
    issues.push({ field: 'productFamily', message: 'Product family is required to publish' });
  }
  if (typeof values.description !== 'string' || values.description.trim() === '') {
    issues.push({ field: 'description', message: 'Description is required to publish' });
  }
  if (
    !Array.isArray(values.imageIds) ||
    !values.imageIds.some((value) => typeof value === 'string' && value.trim() !== '')
  ) {
    issues.push({
      field: 'imageIds',
      message: 'At least one product image is required to publish',
    });
  }
  if (values.archived === true) {
    issues.push({ field: 'archived', message: 'Archived products cannot be published' });
  }
  return issues;
}
