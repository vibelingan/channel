/**
 * Product/security placement boundary for the public assistant.
 *
 * Product/OEM questions belong on these pages, and the two product page kinds
 * carry it so a product opened from the chat in the same tab continues the
 * conversation. Each mounts it once, through `components/AssistantHost.astro`.
 * Account, auth, admin, form-result, preview and customer-project pages are
 * excluded by construction because they do not mount the host.
 */
export const AI_WIDGET_ROUTES = Object.freeze([
  '/',
  '/headphones',
  '/oem',
  '/products/item',
  '/products/[publicKey]',
] as const);
