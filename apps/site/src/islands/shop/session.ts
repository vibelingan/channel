/**
 * Storefront session helper — thin wrapper over the unified site session.
 *
 * Pricing visibility is role-based: admin / contributor / member see VIP
 * pricing; everyone else (viewer, blank role, guests) sees wholesale only.
 * Price inquiry is available to any signed-in user.
 */
export { useSession } from '../auth/useSession.ts';
