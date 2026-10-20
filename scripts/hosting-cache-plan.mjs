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
  const domain = identity.gateway.Domains.find((item) => item.Domain === url.hostname);
  if (!domain || domain.AccessType !== 'DIRECT' || domain.Enable !== true)
    throw new Error('This patch only supports the observed enabled DIRECT domain.');
  const routes = domain.Routes.filter((route) => route.UpstreamResourceType === 'STATIC_STORE');
  if (
    routes.length !== 2 ||
    !['/', '/*'].every((path) => routes.some((route) => route.Path === path)) ||
    routes.some((route) => route.UpstreamResourceName !== 'staticstore' || route.Enable !== true)
  )
    throw new Error('Static route ownership changed; review instead of broadening the patch.');
  const patch = (value) => ({
    EnvId: envId,
    Domain: {
      Domain: url.hostname,
      Routes: routes.map((route) => {
        const extension = structuredClone(route.Extension ?? {});
        const handler = extension.HeadersHandler ?? {};
        const additions = handler.ResponseHeadersToAdd ?? [];
        if (
          (handler.ResponseHeadersToRemove ?? []).some(
            (key) => key.toLowerCase() === 'cache-control',
          )
        )
          throw new Error('Conflicting response header removal requires review.');
        const existing = additions.filter((header) => header.Key.toLowerCase() === 'cache-control');
        if (existing.length > 1 || (existing.length && existing[0].Value !== previousCacheControl))
          throw new Error('Observed policy differs from route header configuration.');
        extension.HeadersHandler = {
          ...handler,
          ResponseHeadersToAdd: [
            ...additions.filter((header) => header.Key.toLowerCase() !== 'cache-control'),
            { Key: 'Cache-Control', Value: value, Action: 'OVERWRITE_IF_EXISTS_OR_ADD' },
          ],
        };
        return { Path: route.Path, Extension: extension };
      }),
    },
  });
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
      'Previously fresh browser caches retain their old lifetime until expiry or explicit client revalidation.',
      'Apply and read-back require the existing shared deployment lock; plan generation does not change the cloud.',
    ],
  };
}
