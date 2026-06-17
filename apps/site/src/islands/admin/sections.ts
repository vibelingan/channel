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
  { label: 'Applications', collection: 'applications' },
];

/** Field used to gate public visibility of catalog items. */
export const PUBLISH_FIELD = 'published';
