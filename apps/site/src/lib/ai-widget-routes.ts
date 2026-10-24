/**
 * Product/security placement boundary for the public assistant.
 *
 * Deliberately small for the pilot: product/OEM questions belong on these
 * pages. Account, auth, admin, form-result, preview and customer-project pages
 * are excluded by construction because they do not import the island.
 */
export const AI_WIDGET_ROUTES = Object.freeze(['/', '/headphones', '/oem'] as const);
