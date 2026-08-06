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
import { ROLES, type Role, canEditCollection, canReadCollection } from './auth.ts';
import { CATALOG_IMAGE_MAX_COUNT, MEDIA_PURPOSES, MEDIA_STATUSES } from './media.ts';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'email'
  | 'select'
  | 'json'
  | 'file';

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
  /** Maximum entries for array-backed JSON fields such as catalog imageIds. */
  maxItems?: number;
  placeholder?: string;
}

/**
 * Generic-admin exposure policy for a collection (DESIGN_CHARTER §7, R1):
 *   - 'crud'     default — the existing role gate applies unchanged
 *   - 'readOnly' admin/contributor may list/get; ALL generic writes rejected
 *   - 'none'     invisible to generic admin CRUD (reads AND writes rejected;
 *                omitted from the `collections` registry dump)
 * Dedicated function actions — never generic CRUD — are the operator surface
 * for 'none'/'readOnly' collections. The hardcoded admin-only trio in
 * auth.ts (users/rateLimitHits/passwordResets) is unaffected and takes
 * precedence.
 */
export type CollectionAdminAccess = 'crud' | 'readOnly' | 'none';

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
  /** Generic-admin exposure policy; absent means 'crud'. */
  adminAccess?: CollectionAdminAccess;
}

/** Collections exposed through the public storefront and image visibility index. */
export const PUBLIC_CATALOG_COLLECTIONS = ['products', 'overstock'] as const;
export type PublicCatalogCollection = (typeof PUBLIC_CATALOG_COLLECTIONS)[number];

/** Channel product categories — shared by the products def and the Alibaba category mapping. */
export const PRODUCT_CATEGORY_OPTIONS = ['wired', 'office', 'bluetooth'] as const;

/** Source-availability states an Alibaba-linked product can carry (ARCHITECTURE §3.10). */
export const ALIBABA_SOURCE_STATUS_OPTIONS = [
  'available',
  'limited',
  'unavailable',
  'removed',
  'unknown',
] as const;

/** Run lifecycle states for alibabaSyncRuns (ARCHITECTURE §12, R1). */
export const ALIBABA_SYNC_RUN_STATUS_OPTIONS = [
  'running',
  'continuing',
  'quarantined',
  'approved',
  'failed',
  'completed',
] as const;

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
        // Derived from the canonical union so a future role (sales, client)
        // can't be assignable here yet silently collapsed to '' by toRole().
        options: [...ROLES],
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
    name: 'oemProjects',
    label: 'OEM Requests',
    description: 'OEM project enquiries submitted from the public OEM page.',
    searchableFields: ['company', 'contact', 'email'],
    fields: [
      { name: 'company', label: 'Company', type: 'string', required: true },
      { name: 'contact', label: 'Contact', type: 'string', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'whatsapp', label: 'WhatsApp', type: 'string' },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: [
          'Plastic Products',
          'Electronics',
          'Headphones',
          'Consumer Goods',
          'Hardware Products',
          'Promotional Products',
          'Other',
        ],
      },
      { name: 'quantity', label: 'Est. Quantity', type: 'number' },
      { name: 'drawingName', label: 'File name', type: 'string', hideInTable: true },
      { name: 'drawing', label: 'Drawing', type: 'file' },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['new', 'reviewing', 'quoted', 'closed'],
        required: true,
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
        options: PRODUCT_CATEGORY_OPTIONS,
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
      {
        name: 'imageIds',
        label: 'Image IDs',
        type: 'json',
        hideInTable: true,
        maxItems: CATALOG_IMAGE_MAX_COUNT,
      },
      { name: 'published', label: 'Published', type: 'boolean' },
      // Alibaba-owned additive fields (ARCHITECTURE §3.10). All server-managed:
      // the sync worker writes them via the trusted repository path; readOnly
      // excludes them from buildWriteSchema so generic admin CRUD rejects them
      // as unknown keys. Legacy pricing fields above remain untouched.
      {
        name: 'alibabaPrimarySourceKey',
        label: 'Alibaba Source Key',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'alibabaPrimaryOfferKey',
        label: 'Alibaba Offer Key',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'alibabaCatalogPricing',
        label: 'Alibaba Pricing',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'alibabaSourceStatus',
        label: 'Alibaba Source Status',
        type: 'select',
        options: ALIBABA_SOURCE_STATUS_OPTIONS,
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'alibabaSourceLastSyncedAt',
        label: 'Alibaba Last Synced',
        type: 'date',
        readOnly: true,
        hideInTable: true,
      },
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
      {
        name: 'imageIds',
        label: 'Image IDs',
        type: 'json',
        hideInTable: true,
        maxItems: CATALOG_IMAGE_MAX_COUNT,
      },
      { name: 'published', label: 'Published', type: 'boolean' },
    ],
  },
  {
    name: 'successStories',
    label: 'Success Stories',
    description: 'Client case studies showcasing OEM/ODM capabilities.',
    searchableFields: ['title', 'client', 'category', 'summary'],
    fields: [
      { name: 'title', label: 'Title', type: 'string', required: true },
      { name: 'client', label: 'Client', type: 'string' },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['Audio', 'Smart Toys', '3C Electronics', 'Consumer Goods', 'Other'],
      },
      { name: 'summary', label: 'Summary', type: 'text', required: true },
      { name: 'situation', label: 'Situation', type: 'text', hideInTable: true },
      { name: 'task', label: 'Task', type: 'text', hideInTable: true },
      { name: 'action', label: 'Action', type: 'text', hideInTable: true },
      { name: 'result', label: 'Result', type: 'text', hideInTable: true },
      { name: 'capabilities', label: 'Capabilities', type: 'string' },
      { name: 'metrics', label: 'Key Metrics', type: 'json', hideInTable: true },
      { name: 'published', label: 'Published', type: 'boolean' },
      { name: 'imageIds', label: 'Image IDs', type: 'json', hideInTable: true },
    ],
  },
  {
    name: 'teardownReports',
    label: 'Teardown Reports',
    description: 'Weekly hardware teardown and BOM cost analysis reports.',
    searchableFields: ['title', 'product', 'category'],
    fields: [
      { name: 'title', label: 'Title', type: 'string', required: true },
      { name: 'slug', label: 'URL Slug', type: 'string', required: true },
      { name: 'product', label: 'Product', type: 'string', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: [
          'Audio & Acoustics',
          'STEM & Robotics',
          '3C Peripherals',
          'Wearables',
          'Smart Home',
        ],
        required: true,
      },
      { name: 'retailPrice', label: 'Retail Price (USD)', type: 'number' },
      { name: 'estBomCost', label: 'Est. BOM Cost (USD)', type: 'number' },
      { name: 'estMargin', label: 'Est. Margin (%)', type: 'number' },
      { name: 'moq', label: 'MOQ', type: 'number' },
      { name: 'summary', label: 'Summary', type: 'text', required: true },
      { name: 'overview', label: 'Product Overview', type: 'text', hideInTable: true },
      { name: 'marketAnalysis', label: 'Market Analysis', type: 'text', hideInTable: true },
      { name: 'hardwareTeardown', label: 'Hardware Teardown', type: 'text', hideInTable: true },
      { name: 'bomBreakdown', label: 'BOM Breakdown (JSON)', type: 'json', hideInTable: true },
      { name: 'riskAnalysis', label: 'Risk Analysis', type: 'text', hideInTable: true },
      { name: 'published', label: 'Published', type: 'boolean' },
      { name: 'publishedAt', label: 'Published Date', type: 'date' },
      { name: 'imageIds', label: 'Image IDs', type: 'json', hideInTable: true },
    ],
  },
  {
    name: 'blueOceanProducts',
    label: 'Blue Ocean Products',
    description: 'Original concept products available for partnership.',
    searchableFields: ['name', 'tagline', 'category'],
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      { name: 'slug', label: 'URL Slug', type: 'string', required: true },
      { name: 'tagline', label: 'Tagline', type: 'string', required: true },
      {
        name: 'category',
        label: 'Category',
        type: 'select',
        options: ['Wearables', 'Education', 'Sports & Outdoor', 'Smart Home', 'Health'],
        required: true,
      },
      { name: 'msrp', label: 'MSRP (USD)', type: 'number', required: true },
      { name: 'estBomCost', label: 'Est. BOM Cost (USD)', type: 'number' },
      { name: 'moq', label: 'MOQ', type: 'number' },
      { name: 'summary', label: 'Summary', type: 'text', required: true },
      { name: 'marketGap', label: 'Market Gap Analysis', type: 'text', hideInTable: true },
      { name: 'techSpecs', label: 'Technical Specs (JSON)', type: 'json', hideInTable: true },
      { name: 'bomBreakdown', label: 'BOM Breakdown (JSON)', type: 'json', hideInTable: true },
      {
        name: 'partnershipTiers',
        label: 'Partnership Tiers (JSON)',
        type: 'json',
        hideInTable: true,
      },
      { name: 'published', label: 'Published', type: 'boolean' },
      { name: 'imageIds', label: 'Image IDs', type: 'json', hideInTable: true },
    ],
  },
  {
    name: 'images',
    label: 'Images',
    // Metadata for image assets referenced by catalog items. Bytes live in
    // CloudBase Storage (storageProvider 'cloudbase-storage' / 'local-disk') or,
    // for legacy records, inline base64 in `data` (storageProvider
    // 'legacy-base64'). Every storage/lifecycle field is server-managed
    // (readOnly): bytes and storage identifiers are never accepted through the
    // generic CRUD surface — only through the dedicated media actions. See
    // docs/IMAGE_UPLOAD_STORAGE_DESIGN.md §20.3 (MIU-01).
    description: 'Image asset metadata referenced by catalog items.',
    searchableFields: ['name'],
    hideFromNav: true,
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      // readOnly: the value is reflected into the public delivery Content-Type,
      // so it is set only by the dedicated media actions from their validated
      // allowlist — never through generic CRUD (a writable mimeType would let a
      // content editor relabel landed bytes as e.g. text/html).
      { name: 'mimeType', label: 'MIME Type', type: 'string', required: true, readOnly: true },
      {
        name: 'purpose',
        label: 'Purpose',
        type: 'select',
        options: MEDIA_PURPOSES,
        readOnly: true,
      },
      { name: 'storageProvider', label: 'Storage Provider', type: 'string', readOnly: true },
      {
        name: 'storageMode',
        label: 'Storage Mode',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'storageFileId',
        label: 'Storage File ID',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'storagePath',
        label: 'Storage Path',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'byteSize', label: 'Byte Size', type: 'number', readOnly: true },
      {
        name: 'checksumSha256',
        label: 'Checksum (SHA-256)',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: MEDIA_STATUSES,
        readOnly: true,
      },
      { name: 'publishedRefCount', label: 'Published Refs', type: 'number', readOnly: true },
      { name: 'variants', label: 'Variants', type: 'json', readOnly: true, hideInTable: true },
      // Legacy base64 bytes (storageProvider 'legacy-base64'). Read-only: new
      // bytes never enter through generic CRUD; legacy reads still work.
      {
        name: 'data',
        label: 'Legacy Data (base64)',
        type: 'text',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'files',
    label: 'Files',
    // OEM file/drawing metadata. Bytes live in CloudBase Storage (storage-backed
    // rows) or, for legacy rows, inline base64 in `data`. Every storage/lifecycle
    // field is server-managed (readOnly): bytes, storage identifiers, the upload
    // secret, and status are never accepted through generic CRUD — only through
    // the dedicated OEM media actions. See §20.10 (MIU-08).
    description: 'OEM file/drawing metadata referenced by OEM project requests.',
    searchableFields: ['name'],
    hideFromNav: true,
    fields: [
      { name: 'name', label: 'Name', type: 'string', required: true },
      // readOnly for the same reason as images.mimeType: server-managed, set
      // only by the dedicated OEM media actions.
      { name: 'mimeType', label: 'MIME Type', type: 'string', required: true, readOnly: true },
      { name: 'purpose', label: 'Purpose', type: 'string', readOnly: true },
      { name: 'storageProvider', label: 'Storage Provider', type: 'string', readOnly: true },
      {
        name: 'storageMode',
        label: 'Storage Mode',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'storageFileId',
        label: 'Storage File ID',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'storagePath',
        label: 'Storage Path',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'byteSize', label: 'Byte Size', type: 'number', readOnly: true },
      {
        name: 'checksumSha256',
        label: 'Checksum',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: MEDIA_STATUSES,
        readOnly: true,
      },
      { name: 'ownerProjectId', label: 'Owner Project', type: 'string', readOnly: true },
      {
        name: 'uploadIntentId',
        label: 'Upload Intent',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'uploadSecretHash',
        label: 'Upload Secret Hash',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'uploadSourceHash',
        label: 'Upload Source Hash',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'uploadExpiresAt',
        label: 'Upload Expires',
        type: 'date',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'finalizeClaim',
        label: 'Finalize Claim',
        type: 'number',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'data',
        label: 'Legacy Data (base64)',
        type: 'text',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'passwordResets',
    label: 'Password Resets',
    // Single-use password-reset tokens. `recover` writes one row per request
    // (bound to a user, or inert with an empty userId for an unknown email so
    // both branches do equal work — timing parity); `resetPassword` consumes it
    // once via an atomic `consumeClaim` CAS. Only the token's SHA-256 is stored,
    // never the raw token. Every field is server-managed (readOnly) and the
    // collection is admin-only + hidden from nav (internal auth plumbing).
    // NOTE (ops): `tokenHash` is looked up on every resetPassword — ensure a
    // CloudBase index exists on it so consume latency doesn't grow with volume.
    description: 'Server-managed single-use password-reset tokens.',
    searchableFields: [],
    hideFromNav: true,
    fields: [
      { name: 'userId', label: 'User', type: 'string', readOnly: true },
      { name: 'tokenHash', label: 'Token Hash', type: 'string', readOnly: true },
      { name: 'expiresAt', label: 'Expires', type: 'date', readOnly: true },
      { name: 'consumeClaim', label: 'Consume Claim', type: 'number', readOnly: true },
    ],
  },
  {
    name: 'rateLimitHits',
    label: 'Rate-Limit Hits',
    // Abuse-control ledger for the UNAUTHENTICATED endpoints (login / recover /
    // submitProject). One row per admitted request within a fixed window; the
    // handler counts rows per (scope, sourceHash) via the reserve-first limiter
    // and reaps stale rows opportunistically. Every field is server-managed
    // (readOnly) so it is never writable through generic CRUD; only the raw
    // client IP's SHA-256 is stored, never the IP itself. Hidden from nav.
    description: 'Server-managed abuse-control ledger for public endpoints.',
    searchableFields: [],
    hideFromNav: true,
    fields: [
      { name: 'scope', label: 'Scope', type: 'string', readOnly: true },
      { name: 'sourceHash', label: 'Source Hash', type: 'string', readOnly: true },
    ],
  },
  // ==================================================================
  // Alibaba Open Platform linked catalog sync (docs/alibaba-linked-
  // catalog-sync/). All ten collections are provider-prefixed; every
  // field is server-managed (the sync function writes via the trusted
  // repository path). adminAccess gates generic admin CRUD exposure:
  // 'none' for secret/coordination state, 'readOnly' for audit mirrors,
  // 'crud' only for the operator-owned category mapping.
  // ==================================================================
  {
    name: 'alibabaConnections',
    label: 'Alibaba Connections',
    description: 'Encrypted Alibaba OAuth token envelopes and connection state.',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'none',
    fields: [
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['active', 'authorization_expired', 'disconnected'],
        readOnly: true,
      },
      { name: 'accountLabel', label: 'Account', type: 'string', readOnly: true },
      {
        name: 'tokenEnvelope',
        label: 'Token Envelope',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'accessTokenExpiresAt', label: 'Access Expires', type: 'date', readOnly: true },
      { name: 'refreshTokenExpiresAt', label: 'Refresh Expires', type: 'date', readOnly: true },
      { name: 'authorizedByUserId', label: 'Authorized By', type: 'string', readOnly: true },
      { name: 'authorizedAt', label: 'Authorized At', type: 'date', readOnly: true },
      {
        name: 'firstAuthErrorAt',
        label: 'Outage Started',
        type: 'date',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'lastAuthErrorAt',
        label: 'Last Auth Error',
        type: 'date',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'alibabaOAuthStates',
    label: 'Alibaba OAuth States',
    description: 'Hashed single-use OAuth state records (10-minute TTL).',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'none',
    fields: [
      { name: 'requestedByUserId', label: 'Requested By', type: 'string', readOnly: true },
      { name: 'intent', label: 'Intent', type: 'string', readOnly: true },
      { name: 'consumeClaim', label: 'Consume Claim', type: 'number', readOnly: true },
      { name: 'expiresAt', label: 'Expires', type: 'date', readOnly: true },
      { name: 'consumedAt', label: 'Consumed', type: 'date', readOnly: true },
    ],
  },
  {
    name: 'alibabaSyncLeases',
    label: 'Alibaba Sync Leases',
    description: 'Fencing lease per connection: holder, heartbeat, expiry, fence token.',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'none',
    fields: [
      { name: 'holder', label: 'Holder', type: 'string', readOnly: true },
      { name: 'fence', label: 'Fence', type: 'number', readOnly: true },
      { name: 'acquiredAt', label: 'Acquired', type: 'date', readOnly: true },
      { name: 'heartbeatAt', label: 'Heartbeat', type: 'date', readOnly: true },
      { name: 'expiresAt', label: 'Expires', type: 'date', readOnly: true },
      { name: 'releasedAt', label: 'Released', type: 'date', readOnly: true },
    ],
  },
  {
    name: 'alibabaSyncCheckpoints',
    label: 'Alibaba Sync Checkpoints',
    description: 'Resumable run cursor and due-schedule state per connection.',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'none',
    fields: [
      { name: 'connectionId', label: 'Connection', type: 'string', readOnly: true },
      { name: 'activeRunId', label: 'Active Run', type: 'string', readOnly: true },
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        options: ['incremental', 'full'],
        readOnly: true,
      },
      { name: 'stage', label: 'Stage', type: 'string', readOnly: true },
      {
        name: 'enumerationState',
        label: 'Enumeration State',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'committedCursor', label: 'Committed Cursor', type: 'string', readOnly: true },
      { name: 'nextFullDueAt', label: 'Next Full Due', type: 'date', readOnly: true },
      { name: 'nextIncrementalDueAt', label: 'Next Incremental Due', type: 'date', readOnly: true },
      { name: 'continuationCount', label: 'Continuations', type: 'number', readOnly: true },
    ],
  },
  {
    name: 'alibabaSourcePayloads',
    label: 'Alibaba Raw Payloads',
    description: 'Immutable metadata for exact raw API response bytes in private storage.',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'readOnly',
    fields: [
      { name: 'connectionId', label: 'Connection', type: 'string', readOnly: true },
      { name: 'runId', label: 'Run', type: 'string', readOnly: true },
      { name: 'endpointId', label: 'Endpoint', type: 'string', readOnly: true },
      {
        name: 'requestFingerprint',
        label: 'Request Fingerprint',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'responseSha256',
        label: 'Response SHA-256',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'byteLength', label: 'Bytes', type: 'number', readOnly: true },
      { name: 'contentType', label: 'Content Type', type: 'string', readOnly: true },
      {
        name: 'storageFileId',
        label: 'Storage Object',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'status', label: 'Status', type: 'string', readOnly: true },
      { name: 'fetchedAt', label: 'Fetched', type: 'date', readOnly: true },
    ],
  },
  {
    name: 'alibabaSourceProducts',
    label: 'Alibaba Source Products',
    description: 'Current parsed mirror of the authorized Alibaba source catalog.',
    searchableFields: ['sourceTitle', 'sourceProductId'],
    hideFromNav: true,
    adminAccess: 'readOnly',
    fields: [
      { name: 'sourceKey', label: 'Source Key', type: 'string', readOnly: true, hideInTable: true },
      {
        name: 'connectionId',
        label: 'Connection',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceProductId', label: 'Source Product ID', type: 'string', readOnly: true },
      { name: 'payloadId', label: 'Payload', type: 'string', readOnly: true, hideInTable: true },
      { name: 'sourceTitle', label: 'Title', type: 'string', readOnly: true },
      {
        name: 'sourceDescription',
        label: 'Description',
        type: 'text',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceCategoryId', label: 'Source Category', type: 'string', readOnly: true },
      {
        name: 'sourceCategoryPath',
        label: 'Category Path',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'sourceImageUrls',
        label: 'Image URLs',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceUpdatedAt', label: 'Source Updated', type: 'string', readOnly: true },
      { name: 'fetchedAt', label: 'Fetched', type: 'date', readOnly: true },
      { name: 'active', label: 'Active', type: 'boolean', readOnly: true },
      {
        name: 'firstSeenRunId',
        label: 'First Seen Run',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'lastSeenRunId',
        label: 'Last Seen Run',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'tombstonedAt',
        label: 'Tombstoned',
        type: 'date',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'parseVersion',
        label: 'Parse Version',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'alibabaProductLinks',
    label: 'Alibaba Product Links',
    description:
      'Deterministic one-to-one mapping from an Alibaba source product to a Channel product.',
    searchableFields: ['sourceProductId', 'productId'],
    hideFromNav: true,
    adminAccess: 'readOnly',
    fields: [
      { name: 'sourceKey', label: 'Source Key', type: 'string', readOnly: true, hideInTable: true },
      {
        name: 'connectionId',
        label: 'Connection',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceProductId', label: 'Source Product ID', type: 'string', readOnly: true },
      { name: 'productId', label: 'Channel Product', type: 'string', readOnly: true },
      { name: 'linkedByUserId', label: 'Linked By', type: 'string', readOnly: true },
      { name: 'linkedAt', label: 'Linked At', type: 'date', readOnly: true },
    ],
  },
  {
    name: 'alibabaSupplierOffers',
    label: 'Alibaba Supplier Offers',
    description: 'Normalized product/SKU commercial truth from the Alibaba source.',
    searchableFields: ['sourceProductId', 'sourceSkuId'],
    hideFromNav: true,
    adminAccess: 'readOnly',
    fields: [
      { name: 'offerKey', label: 'Offer Key', type: 'string', readOnly: true, hideInTable: true },
      { name: 'sourceKey', label: 'Source Key', type: 'string', readOnly: true, hideInTable: true },
      {
        name: 'connectionId',
        label: 'Connection',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceProductId', label: 'Source Product ID', type: 'string', readOnly: true },
      { name: 'sourceSkuId', label: 'Source SKU', type: 'string', readOnly: true },
      { name: 'active', label: 'Active', type: 'boolean', readOnly: true },
      {
        name: 'sourceAttributes',
        label: 'Attributes',
        type: 'json',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'sourceAvailability', label: 'Availability', type: 'number', readOnly: true },
      { name: 'pricing', label: 'Pricing', type: 'json', readOnly: true, hideInTable: true },
      { name: 'sourceUpdatedAt', label: 'Source Updated', type: 'string', readOnly: true },
      { name: 'syncedAt', label: 'Synced', type: 'date', readOnly: true },
      {
        name: 'lastSeenRunId',
        label: 'Last Seen Run',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'alibabaSyncRuns',
    label: 'Alibaba Sync Runs',
    description: 'Run lifecycle, counters, diffs, quarantine and approval audit.',
    searchableFields: [],
    hideFromNav: true,
    adminAccess: 'readOnly',
    fields: [
      {
        name: 'connectionId',
        label: 'Connection',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        options: ['incremental', 'full'],
        readOnly: true,
      },
      {
        name: 'trigger',
        label: 'Trigger',
        type: 'select',
        options: ['timer', 'manual', 'continuation'],
        readOnly: true,
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ALIBABA_SYNC_RUN_STATUS_OPTIONS,
        readOnly: true,
      },
      { name: 'holder', label: 'Holder', type: 'string', readOnly: true, hideInTable: true },
      { name: 'fence', label: 'Fence', type: 'number', readOnly: true, hideInTable: true },
      {
        name: 'candidateHash',
        label: 'Candidate Hash',
        type: 'string',
        readOnly: true,
        hideInTable: true,
      },
      { name: 'startedAt', label: 'Started', type: 'date', readOnly: true },
      { name: 'completedAt', label: 'Completed', type: 'date', readOnly: true },
      { name: 'counters', label: 'Counters', type: 'json', readOnly: true, hideInTable: true },
      { name: 'alerts', label: 'Alerts', type: 'json', readOnly: true, hideInTable: true },
      { name: 'approval', label: 'Approval', type: 'json', readOnly: true, hideInTable: true },
      {
        name: 'errorSummary',
        label: 'Error Summary',
        type: 'text',
        readOnly: true,
        hideInTable: true,
      },
    ],
  },
  {
    name: 'alibabaCategoryMappings',
    label: 'Alibaba Category Mappings',
    description:
      'Operator-owned mapping from Alibaba source categories to Channel categories; drafts are created only for mapped categories.',
    searchableFields: ['alibabaCategoryId', 'alibabaCategoryLabel'],
    adminAccess: 'crud',
    fields: [
      { name: 'alibabaCategoryId', label: 'Alibaba Category ID', type: 'string', required: true },
      { name: 'alibabaCategoryLabel', label: 'Alibaba Category Label', type: 'string' },
      {
        name: 'channelCategory',
        label: 'Channel Category',
        type: 'select',
        options: PRODUCT_CATEGORY_OPTIONS,
        required: true,
      },
      { name: 'notes', label: 'Notes', type: 'text', hideInTable: true },
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

/** Effective generic-admin policy for a registered collection ('crud' when absent). */
export function collectionAdminAccess(name: string): CollectionAdminAccess {
  return COLLECTION_MAP.get(name)?.adminAccess ?? 'crud';
}

/**
 * Registry-aware generic-CRUD gates (R1). These — not the bare role gates in
 * auth.ts — are what the admin handler consults, so the adminAccess policy is
 * enforced at one seam. They live here rather than in auth.ts because
 * collections.ts already imports auth.ts at module init (ROLES); the reverse
 * import would be a TDZ cycle, and auth.ts stays dependency-free by design.
 * The hardcoded admin-only trio keeps precedence via the underlying gates.
 */
export function canReadRegisteredCollection(role: Role, name: string): boolean {
  if (collectionAdminAccess(name) === 'none') return false;
  return canReadCollection(role, name);
}

export function canEditRegisteredCollection(role: Role, name: string): boolean {
  if (collectionAdminAccess(name) !== 'crud') return false;
  return canEditCollection(role, name);
}

/** Registry defs visible to the generic admin `collections` dump (R1: 'none' omitted). */
export function adminVisibleCollections(): readonly CollectionDef[] {
  return COLLECTIONS.filter((def) => (def.adminAccess ?? 'crud') !== 'none');
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
      schema =
        field.maxItems === undefined
          ? z.unknown()
          : z.unknown().superRefine((value, ctx) => {
              if (Array.isArray(value) && value.length > (field.maxItems ?? 0)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `${field.label} must contain at most ${field.maxItems} items`,
                });
              }
            });
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
