/** Admin list DTO protocol. Never persist these response-only markers. */
export const ADMIN_PRODUCT_LIST_VIEW = 'admin-product-list-v1' as const;
export const ADMIN_PRODUCT_LIST_MARKER = '_adminProductListView' as const;
export type AdminProductListView = typeof ADMIN_PRODUCT_LIST_VIEW;
