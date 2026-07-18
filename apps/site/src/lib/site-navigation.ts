import type { NavItem } from '../i18n/site.ts';

/** Canonical destination for CTAs whose intent is to start a new OEM project. */
export const OEM_INQUIRY_HREF = '/#oem-inquiry';

/**
 * Keep the OEM entry first without coupling ordering to its `#what-we-do` fragment.
 */
export function orderPrimaryNavItems(items: NavItem[]): NavItem[] {
  const priority = (item: NavItem) => Number(item.href.split('#', 1)[0] === '/oem');
  return [...items].sort((a, b) => priority(b) - priority(a));
}
