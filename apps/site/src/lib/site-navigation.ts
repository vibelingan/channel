import type { NavItem } from '../i18n/site.ts';

/**
 * Keep the OEM entry first without coupling ordering to an exact fragment.
 * A later phase changes `/oem` to `/oem#what-we-do`; both share the same pathname.
 */
export function orderPrimaryNavItems(items: NavItem[]): NavItem[] {
  const priority = (item: NavItem) => Number(item.href.split('#', 1)[0] === '/oem');
  return [...items].sort((a, b) => priority(b) - priority(a));
}
