/**
 * Dashboard sections — a feature-oriented view over the raw collections.
 *
 * Instead of exposing every registered collection as a flat list, the admin
 * dashboard groups them into meaningful features. The `images` collection is
 * intentionally absent: images are managed inline while editing a Product or
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
  custom?: 'alibaba-sync' | 'catalog-import';
}

export const DASHBOARD_SECTIONS: readonly DashboardSection[] = [
  {
    label: 'Users',
    collection: 'users',
    adminOnly: true,
    inlineEdit: ['role', 'status'],
  },
  { label: 'Products', collection: 'products', catalog: true },
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
  // Provider-neutral catalog import (docs/dianxiaomi-excel-import). Read-only:
  // importing and publishing run from the local CLI in this branch, so the
  // admin surface is "see what this file would do" and nothing else.
  // catalogImportJobs is hideFromNav + adminAccess 'readOnly', so CollectionView
  // would render New/Edit/Delete buttons that can only 403 — hence a custom page.
  {
    label: 'Catalog Import',
    collection: 'catalogImportJobs',
    adminOnly: true,
    custom: 'catalog-import',
  },
  // Source category -> Channel product family. Ordinary contributor-editable
  // CRUD, because it is the operator decision that gates publication.
  { label: 'Import Categories', collection: 'sourceCategoryMappings' },
  // NOT alibabaSourceProducts / alibabaSupplierOffers: both are hideFromNav by
  // registry contract (MIU 3 acceptance criterion), and CollectionView renders
  // New/Edit/Delete unconditionally — on an adminAccess 'readOnly' collection
  // those buttons can only 403. Source-key discovery belongs on the read-only
  // ops page instead; tracked as follow-up, not smuggled in through the nav.
];

/** Field used to gate public visibility of catalog items. */
export const PUBLISH_FIELD = 'published';
