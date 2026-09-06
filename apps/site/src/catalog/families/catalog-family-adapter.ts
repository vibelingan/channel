import { type PublicProduct, PublicProductSchema } from '@vibelingan-channel/shared/catalog';

type ProductFamily = PublicProduct['productFamily'];

export interface CatalogFamilyFilterCapability {
  key: string;
  label: string;
}

export interface CatalogFamilyFact {
  key: string;
  label: string;
  value: string | number;
}

export interface CatalogFamilyAdapter {
  family: ProductFamily;
  labels: Readonly<Record<string, string>>;
  filterCapabilities: readonly CatalogFamilyFilterCapability[];
  group(product: PublicProduct): string | null;
  facts(product: PublicProduct): readonly CatalogFamilyFact[];
  emptyCopy: string;
}

function invalid(field?: keyof CatalogFamilyAdapter): never {
  throw new TypeError(`Invalid CatalogFamilyAdapter${field ? `.${field}` : ''}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function ownDataValue(
  record: object,
  key: PropertyKey,
  field: keyof CatalogFamilyAdapter,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) invalid(field);
  return descriptor.value;
}

export function assertCatalogFamilyAdapter(
  adapter: unknown,
): asserts adapter is CatalogFamilyAdapter {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) invalid();
  const family = ownDataValue(adapter, 'family', 'family');
  if (!PublicProductSchema.shape.productFamily.safeParse(family).success) invalid('family');

  const labels = ownDataValue(adapter, 'labels', 'labels');
  if (
    typeof labels !== 'object' ||
    labels === null ||
    Array.isArray(labels) ||
    Object.getOwnPropertyNames(labels).length === 0
  ) {
    invalid('labels');
  }
  for (const key of Object.getOwnPropertyNames(labels)) {
    if (!isNonEmptyString(ownDataValue(labels, key, 'labels'))) invalid('labels');
  }

  const capabilities = ownDataValue(adapter, 'filterCapabilities', 'filterCapabilities');
  if (!Array.isArray(capabilities)) invalid('filterCapabilities');
  const length = ownDataValue(capabilities, 'length', 'filterCapabilities');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('filterCapabilities');
  }
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(capabilities, index)) invalid('filterCapabilities');
    const capability = ownDataValue(capabilities, index, 'filterCapabilities');
    if (typeof capability !== 'object' || capability === null || Array.isArray(capability)) {
      invalid('filterCapabilities');
    }
    if (
      !isNonEmptyString(ownDataValue(capability, 'key', 'filterCapabilities')) ||
      !isNonEmptyString(ownDataValue(capability, 'label', 'filterCapabilities'))
    ) {
      invalid('filterCapabilities');
    }
  }
  if (typeof ownDataValue(adapter, 'group', 'group') !== 'function') invalid('group');
  if (typeof ownDataValue(adapter, 'facts', 'facts') !== 'function') invalid('facts');
  if (!isNonEmptyString(ownDataValue(adapter, 'emptyCopy', 'emptyCopy'))) invalid('emptyCopy');
}
