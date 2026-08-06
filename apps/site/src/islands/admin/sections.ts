/**
 * Dashboard sections — a feature-oriented view over the raw collections.
 *
 * Instead of exposing every registered collection as a flat list, the admin
 * dashboard groups them into meaningful features. The `images` collection is
 * intentionally absent: images are managed inline while editing a Headphones or
 * Overstock item, not as a standalone list.
 */
export interface DashboardSection {
  /** Feature label shown in the navigation. */
  label: string;
  /** Underlying registry collection name. */
  collection: string;
  /** Only admins may see/use this section. */
  adminOnly?: boolean;
  /** Select fields that can be edited inline in the grid (e.g. user role). */
  inlineEdit?: readonly string[];
  /**
   * Catalog feature: enables the publish/disable workflow, item preview, and
   * the inline image manager in the edit form.
   */
  catalog?: boolean;
  /** Custom page id: renders a dedicated component instead of CollectionView. */
  custom?: 'alibaba-sync';
}

export const DASHBOARD_SECTIONS: readonly DashboardSection[] = [
  {
    label: 'Users',
    collection: 'users',
    adminOnly: true,
    inlineEdit: ['role', 'status'],
  },
  { label: 'Headphones', collection: 'products', catalog: true },
  { label: 'Overstock', collection: 'overstock', catalog: true },
  { label: 'OEM Requests', collection: 'oemProjects', inlineEdit: ['status'] },
  // Alibaba linked catalog sync (docs/alibaba-linked-catalog-sync, MIU 13).
  // The ops page is admin-only (the connection lifecycle requires the admin
  // role server-side); category mappings stay an ordinary contributor-editable
  // CRUD section — they gate draft creation.
  {
    label: 'Alibaba Sync',
    collection: 'alibabaSyncRuns',
    adminOnly: true,
    custom: 'alibaba-sync',
  },
  { label: 'Alibaba Categories', collection: 'alibabaCategoryMappings' },
  // The MIRROR itself, read-only (blessing-gate P2). Both collections are
  // adminAccess 'readOnly' and therefore listable, and the ops page links
  // products BY source key — an operator who cannot browse the mirror has no
  // way to discover the key they are asked to supply.
  { label: 'Alibaba Sources', collection: 'alibabaSourceProducts' },
  { label: 'Alibaba Offers', collection: 'alibabaSupplierOffers' },
];

/** Field used to gate public visibility of catalog items. */
export const PUBLISH_FIELD = 'published';
