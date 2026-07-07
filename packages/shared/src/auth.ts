/**
 * Role-based entitlement model — shared by the backend (authorization) and the
 * frontend (UI gating). Pure, dependency-free so both sides agree on the rules.
 *
 * Roles (highest to lowest privilege):
 *   - admin       Full access. Manages users and can grant/remove any role.
 *   - contributor Edits content collections (products, overstock, images, …)
 *                 but cannot manage users or grant roles.
 *   - member      View-only storefront, sees VIP pricing.
 *   - viewer      View-only storefront, wholesale pricing only.
 *   - '' (blank)  Default for newly-registered users. Base access; treated like
 *                 a viewer for pricing. `member`/`viewer` are reserved for
 *                 explicit assignment later.
 */
// Ascending privilege — also the display order for admin role-select options.
export const ROLES = ['viewer', 'member', 'contributor', 'admin'] as const;
export type AssignableRole = (typeof ROLES)[number];
/** A user's role; '' (blank) is the default base entitlement. */
export type Role = AssignableRole | '';

/**
 * Narrow an untrusted value (DB row field, JWT payload claim) to a `Role`.
 * Anything off the union collapses to `''` (base entitlement), so a corrupted
 * or hand-edited role can only ever LOSE privileges, never gain them.
 */
export function toRole(value: unknown): Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
    ? (value as Role)
    : '';
}

/** Can the role reach the admin dashboard at all? */
export function canAccessAdmin(role: Role): boolean {
  return role === 'admin' || role === 'contributor';
}

/** Can the role manage users (list users + grant/remove roles)? Admin only. */
export function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

/** Can the role create/update/remove a given collection via the admin API? */
export function canEditCollection(role: Role, collection: string): boolean {
  // The users collection holds entitlement — only admins may touch it.
  if (collection === 'users') return role === 'admin';
  // Everything else (products, overstock, images, …) is open to contributors.
  return role === 'admin' || role === 'contributor';
}

/** Can the role read a given collection through the admin dashboard? */
export function canReadCollection(role: Role, collection: string): boolean {
  if (collection === 'users') return role === 'admin';
  return role === 'admin' || role === 'contributor';
}

/** Does the role unlock VIP pricing on the storefront? */
export function canSeeVipPricing(role: Role): boolean {
  return role === 'admin' || role === 'contributor' || role === 'member';
}

/** The minimal, safe representation of a signed-in user shared with clients. */
export interface SessionUser {
  id: string;
  email: string;
  username: string;
  role: Role;
}
