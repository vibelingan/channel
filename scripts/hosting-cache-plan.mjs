import { createHash } from 'node:crypto';
import { hostingConfigurationIdentity } from './hosting-recovery.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Prepare an incremental API patch; this module never calls a mutation API. */
export function planHostingCacheChange({ configuration, envId, site, previousCacheControl }) {
  const identity = hostingConfigurationIdentity(configuration);
  const url = new URL(site);
  if (url.origin !== site || url.protocol !== 'https:' || !envId)
    throw new Error('Explicit HTTPS site origin and environment are required.');
  if (!previousCacheControl || /[\r\n]/.test(previousCacheControl))
    throw new Error('An observed previous cache policy is required for backout.');
  const matches = identity.gateway.Domains.filter((item) => item.Domain === url.hostname);
  if (matches.length !== 1) throw new Error('Hosting domain identity is ambiguous.');
  const domain = matches[0];
  assertStaticDomainCacheScope(domain);
  const patch = (value) => {
    const extension = structuredClone(domain.Extension ?? {});
    const handler = extension.HeadersHandler ?? {};
    const additions = handler.ResponseHeadersToAdd ?? [];
    if (
      (handler.ResponseHeadersToRemove ?? []).some((key) => key.toLowerCase() === 'cache-control')
    )
      throw new Error('Conflicting response header removal requires review.');
    const existing = additions.filter((header) => header.Key.toLowerCase() === 'cache-control');
    if (existing.length > 1 || (existing.length && existing[0].Value !== previousCacheControl))
      throw new Error('Observed policy differs from domain header configuration.');
    extension.HeadersHandler = {
      ...handler,
      ResponseHeadersToAdd: [
        ...additions.filter((header) => header.Key.toLowerCase() !== 'cache-control'),
        { Key: 'Cache-Control', Value: value, Action: 'OVERWRITE_IF_EXISTS_OR_ADD' },
      ],
    };
    return { EnvId: envId, Domain: { Domain: url.hostname, Extension: extension } };
  };
  return {
    schemaVersion: 1,
    action: 'ModifyHTTPServiceRoute',
    configurationSha256: digest(identity),
    forward: patch('no-cache'),
    backout: patch(previousCacheControl),
    backoutScope: 'restore-observed-response-policy',
    limitations: [
      'Backout restores the previous HTTP policy; it does not remove a previously absent header override.',
      'All static files revalidate, including hashed assets; API routes are not changed.',
      'The domain must contain only the two owned static routes; adding an API route requires a new cache review.',
      'Previously fresh browser caches retain their old lifetime until expiry or explicit client revalidation.',
      'Apply and read-back require the existing shared deployment lock; plan generation does not change the cloud.',
    ],
  };
}

/** Domain headers must never spread a static policy onto an API or override a route policy. */
export function assertStaticDomainCacheScope(domain) {
  const routes = domain?.Routes;
  if (
    domain?.AccessType !== 'DIRECT' ||
    domain.Enable !== true ||
    !Array.isArray(routes) ||
    routes.length !== 2 ||
    !['/', '/*'].every((path) => routes.some((route) => route.Path === path)) ||
    routes.some(
      (route) =>
        route.UpstreamResourceType !== 'STATIC_STORE' ||
        route.UpstreamResourceName !== 'staticstore' ||
        route.Enable !== true,
    )
  )
    throw new Error('Domain cache headers require exactly the two owned static routes.');
  for (const route of routes) {
    const headers = route.Extension?.HeadersHandler;
    if (
      (headers?.ResponseHeadersToAdd ?? []).some(
        (item) => item.Key.toLowerCase() === 'cache-control',
      ) ||
      (headers?.ResponseHeadersToRemove ?? []).some((key) => key.toLowerCase() === 'cache-control')
    )
      throw new Error('Route cache headers conflict with the domain policy.');
  }
}
