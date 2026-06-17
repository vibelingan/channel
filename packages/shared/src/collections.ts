/**
 * Collection registry — the single source of truth for every data collection
 * managed by the admin portal.
 *
 * Adding a new collection to the system is a ONE-PLACE change: append a
 * `CollectionDef` to the `COLLECTIONS` array below. From that single definition
 * the system derives:
 *   - the admin table columns and the create/edit form fields (browser)
 *   - the server-side validation schema (cloud function + local-server)
 *   - the list of searchable fields
 *
 * No other file needs to change to support CRUD on a brand new collection.
 */
import { z } from 'zod';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'email'
  | 'select'
  | 'json';

export interface FieldDef {
  /** Property name as stored in the database document. */
  name: string;
  /** Human label shown in the admin UI. */
  label: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values for `type: 'select'`. */
  options?: readonly string[];
  /** Server-managed field: shown read-only in the UI, never accepted on write. */
  readOnly?: boolean;
  /** Hide from the table list view (still editable in the detail form). */
  hideInTable?: boolean;
  placeholder?: string;
}

export interface CollectionDef {
  /** Database collection name (wx-server-sdk collection id). */
  name: string;
  /** Human label shown in the admin navigation. */
  label: string;
  description?: string;
  /** Fields the free-text search box matches against. */
  searchableFields: readonly string[];
  fields: readonly FieldDef[];
  /** Hide from the dashboard navigation (managed indirectly, e.g. images). */
  hideFromNav?: boolean;
}

/**
 * Fields every document gets automatically. They are server-managed and never
 * writable from the client.
 */
export const SYSTEM_FIELDS: readonly FieldDef[] = [
  { name: '_id', label: 'ID', type: 'string', readOnly: true },
  { name: 'createdAt', label: 'Created', type: 'date', readOnly: true, hideInTable: true },
  { name: 'updatedAt', label: 'Updated', type: 'date', readOnly: true, hideInTable: true },
] as const;

/**
 * ====================================================================
 * Registered collections. Add new collections here.
 * ====================================================================
 */
export const COLLECTIONS: readonly CollectionDef[] = [
  {
    name: 'users',
    label: 'Users',
    description: 'Portal accounts and their role-based entitlements.',
    searchableFields: ['email', 'username'],
    fields: [
      { name: 'username', label: 'Username', type: 'string', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      {
        name: 'role',
        label: 'Role',
        type: 'select',
        // Blank (no selection) = base entitlement; admins assign the rest.
        options: ['viewer', 'member', 'contributor', 'admin'],
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['active', 'suspended'],
      },
      // Server-managed: the argon2id hash is set only by the auth flow, never
      // through the generic admin CRUD, and is redacted from API responses.
      {
        name: 'passwordHash',
        label: 'Password Hash',
        type: 'text',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'lastLoginAt', label: 'Last Login', type: 'date', readOnly: true, hideInTable: true },
      {
        name: 'loginCount',
        label: 'Login Count',
        type: 'number',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'products',
    label: 'Products',
    description: 'Catalog products (headphones and other categories).',
    searchableFields: ['name', 'series', 'modName'],
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['wired', 'office', 'bluetooth'],
        required: true,
      },
      { name: 'series', label: 'Series', type: 'string' },
      { name: 'modName', label: 'Model Name', type: 'string' },
      { name: 'modType', label: 'Model Type', type: 'string' },
      { name: 'description', label: 'Description', type: 'text', hideInTable: true },
      { name: 'moq', label: 'MOQ', type: 'number' },
      { name: 'unitPrice', label: 'Unit Price', type: 'number' },
      { name: 'wholesalePrice', label: 'Wholesale Price', type: 'number' },
      { name: 'vipPrice', label: 'VIP Price', type: 'number' },
      { name: 'imageIds', label: 'Image IDs', type: 'json', hideInTable: true },
      { name: 'published', label: 'Published', type: 'boolean' },
    ],
  },
  {
    name: 'overstock',
    label: 'Overstock',
    description: 'Clearance / overstock inventory available for batch inquiry.',
    searchableFields: ['name', 'productCode'],
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: [
          'electronics',
          'headphones',
          'phone-accessories',
          'home',
          'promotional',
          'seasonal',
        ],
        required: true,
      },
      { name: 'productCode', label: 'Product Code', type: 'string' },
      { name: 'description', label: 'Description', type: 'text', hideInTable: true },
      { name: 'inventory', label: 'Inventory', type: 'number' },
      { name: 'moq', label: 'MOQ', type: 'number' },
      { name: 'unitPrice', label: 'Unit Price', type: 'number' },
      { name: 'clearancePrice', label: 'Clearance Price', type: 'number' },
      { name: 'wholesalePrice', label: 'Wholesale Price', type: 'number' },
      { name: 'vipPrice', label: 'VIP Price', type: 'number' },
      { name: 'imageIds', label: 'Image IDs', type: 'json', hideInTable: true },
      { name: 'published', label: 'Published', type: 'boolean' },
    ],
  },
  {
    name: 'images',
    label: 'Images',
    description: 'Binary image assets (stored as base64 bytes) referenced by catalog items.',
    searchableFields: ['name'],
    hideFromNav: true,
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      { name: 'mimeType', label: 'MIME Type', type: 'string', required: true },
      { name: 'data', label: 'Data (base64)', type: 'text', hideInTable: true },
    ],
  },
] as const;

const COLLECTION_MAP = new Map(COLLECTIONS.map((c) => [c.name, c]));

export function getCollection(name: string): CollectionDef | undefined {
  return COLLECTION_MAP.get(name);
}

export function isKnownCollection(name: string): boolean {
  return COLLECTION_MAP.has(name);
}

/** All writable (non-readOnly, non-system) fields for a collection. */
export function writableFields(def: CollectionDef): readonly FieldDef[] {
  return def.fields.filter((f) => !f.readOnly);
}

function zodForField(field: FieldDef): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'email':
      schema = z.string().email();
      break;
    case 'date':
      schema = z.union([z.string(), z.date()]);
      break;
    case 'select':
      schema =
        field.options && field.options.length > 0
          ? z.enum([field.options[0], ...field.options.slice(1)] as [string, ...string[]])
          : z.string();
      break;
    case 'json':
      schema = z.unknown();
      break;
    default:
      schema = z.string();
  }
  if (field.required) {
    if (schema instanceof z.ZodString) schema = schema.min(1, `${field.label} is required`);
    return schema;
  }
  return schema.optional();
}

/** Build a Zod validation schema for the writable fields of a collection. */
export function buildWriteSchema(def: CollectionDef): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const field of writableFields(def)) {
    shape[field.name] = zodForField(field);
  }
  // Reject unknown keys so clients cannot write arbitrary data.
  return z.object(shape).strict();
}

/** A stored document: registry fields plus the system fields. */
export type CollectionDoc = Record<string, unknown> & {
  _id: string;
  createdAt?: string;
  updatedAt?: string;
};
