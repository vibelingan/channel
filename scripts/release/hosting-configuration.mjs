import { isReviewedBlogRoute } from '../blog/server-routes.mjs';
import { assertStaticDomainCacheScope, planHostingCacheChange } from '../hosting-cache-plan.mjs';
import { assertMutableCachePolicy } from '../hosting-contract.mjs';
import { hostingConfigurationIdentity } from '../hosting-recovery.mjs';
import { assertOrigin, freeze, identity, sha256 } from './input.mjs';

export const errorDocumentPath = 'errors/not-found.html';

export const configurationHash = (config) =>
  sha256(JSON.stringify(hostingConfigurationIdentity(config)));
// Domain/route timestamps are server metadata, not writable configuration fields.
// Keep configurationHash as the immutable artifact snapshot identity.
export function configurationStateHash(config) {
  const snapshot = hostingConfigurationIdentity(config);
  const domains = snapshot.gateway.Domains.map((domain) => {
    const { CreateTime, UpdateTime, ...fields } = domain;
    if (fields.Routes)
      fields.Routes = fields.Routes.map((route) => {
        const { CreateTime, UpdateTime, ...settings } = route;
        return settings;
      });
    return fields;
  });
  return identity({ ...snapshot, gateway: { ...snapshot.gateway, Domains: domains } });
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Keep exact intermediate configurations so each provider mutation has its own journal step. */
export function prepareHostingConfiguration({
  target,
  before,
  errorDocument,
  cacheControl,
  previousCacheControl,
}) {
  assertOrigin(target.site);
  if (!target.envId) throw new Error('Explicit hosting environment required');
  const source = copy(hostingConfigurationIdentity(before));
  websiteArguments(source.website.WebsiteConfiguration);
  let after = copy(source);
  const changes = [];
  const add = (kind, args, next) => {
    changes.push({
      kind,
      args: copy(args),
      before: after,
      after: copy(next),
      beforeHash: configurationStateHash(after),
      afterHash: configurationStateHash(next),
    });
    after = copy(next);
  };
  if (
    errorDocument !== undefined &&
    (errorDocument !== source.website.WebsiteConfiguration.ErrorDocument?.Key ||
      source.website.WebsiteConfiguration.ErrorDocument?.OriginalHttpStatus !== 'Enabled')
  ) {
    const next = copy(after);
    next.website.WebsiteConfiguration.ErrorDocument = {
      ...next.website.WebsiteConfiguration.ErrorDocument,
      Key: errorDocument,
      OriginalHttpStatus: 'Enabled',
    };
    add('website', websiteArguments(next.website.WebsiteConfiguration), next);
  }
  if (cacheControl !== undefined) {
    assertMutableCachePolicy(cacheControl);
    const plan = planHostingCacheChange({
      configuration: after,
      envId: target.envId,
      site: target.site,
      previousCacheControl,
    });
    const args = copy(plan.forward);
    args.Domain.Extension.HeadersHandler.ResponseHeadersToAdd.find(
      (h) => h.Key.toLowerCase() === 'cache-control',
    ).Value = cacheControl;
    const next = copy(after);
    const domain = domainFor(next, target);
    domain.Extension = copy(args.Domain.Extension);
    if (!same(after, next)) add('domain-headers', args, next);
  }
  assertSafeConfiguration(after, target);
  return freeze({ schemaVersion: 1, target: copy(target), before: source, after, changes });
}

export function inverseHostingConfiguration({ plan, current }) {
  if (configurationStateHash(current) !== configurationStateHash(plan.after))
    throw new Error('Configuration changed before inverse');
  assertSafeConfiguration(plan.before, plan.target);
  return freeze({
    schemaVersion: 1,
    target: copy(plan.target),
    before: copy(plan.after),
    after: copy(plan.before),
    changes: [...plan.changes].reverse().map((change) => {
      let args;
      if (change.kind === 'website')
        args = websiteArguments(change.before.website.WebsiteConfiguration);
      else {
        const prior = domainFor(change.before, plan.target);
        args = {
          EnvId: plan.target.envId,
          Domain: {
            Domain: prior.Domain,
            Extension: copy(prior.Extension ?? {}),
          },
        };
      }
      return {
        kind: change.kind,
        args,
        before: copy(change.after),
        after: copy(change.before),
        beforeHash: change.afterHash,
        afterHash: change.beforeHash,
      };
    }),
  });
}

export function websiteArguments(config) {
  const keys = (value, allowed) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw new Error('Unsupported website configuration; preserve it and review');
  };
  keys(config, ['IndexDocument', 'ErrorDocument', 'RoutingRules', 'AutoAddressing']);
  keys(config.IndexDocument, ['Suffix']);
  if (config.ErrorDocument) keys(config.ErrorDocument, ['Key', 'OriginalHttpStatus', 'Charity404']);
  if (config.AutoAddressing) keys(config.AutoAddressing, ['Status']);
  for (const value of [
    config.ErrorDocument?.OriginalHttpStatus,
    config.ErrorDocument?.Charity404,
    config.AutoAddressing?.Status,
  ])
    if (value !== undefined && !['Enabled', 'Disabled'].includes(value))
      throw new Error('Unsupported website flag; expected Enabled or Disabled');
  const args = {
    indexDocument: config.IndexDocument.Suffix,
    ...(config.ErrorDocument
      ? {
          errorDocument: config.ErrorDocument.Key,
          originalHttpStatus: config.ErrorDocument.OriginalHttpStatus,
          charity404: config.ErrorDocument.Charity404,
        }
      : {}),
    ...(config.AutoAddressing ? { autoAddressing: config.AutoAddressing.Status } : {}),
  };
  if (config.RoutingRules)
    args.routingRules = config.RoutingRules.map((rule) => {
      keys(rule, ['Condition', 'Redirect']);
      keys(rule.Condition, ['KeyPrefixEquals', 'HttpErrorCodeReturnedEquals']);
      keys(rule.Redirect, ['ReplaceKeyWith', 'ReplaceKeyPrefixWith']);
      if (
        Object.keys(rule.Condition).length !== 1 ||
        Object.keys(rule.Redirect).length !== 1 ||
        [...Object.values(rule.Condition), ...Object.values(rule.Redirect)].some(
          (value) => typeof value !== 'string' || !value,
        )
      )
        throw new Error('Website route cannot roundtrip through SDK');
      return Object.fromEntries(
        [...Object.entries(rule.Condition), ...Object.entries(rule.Redirect)].map(
          ([key, value]) => [key[0].toLowerCase() + key.slice(1), value],
        ),
      );
    });
  return copy(args);
}

export function assertSafeConfiguration(config, target) {
  const website = config.website.WebsiteConfiguration;
  websiteArguments(website);
  if (
    website.IndexDocument.Suffix !== 'index.html' ||
    website.ErrorDocument?.Key !== errorDocumentPath ||
    website.ErrorDocument?.OriginalHttpStatus !== 'Enabled' ||
    website.ErrorDocument?.Charity404 === 'Enabled' ||
    (website.RoutingRules ?? []).some((rule) => rule.Condition.HttpErrorCodeReturnedEquals)
  )
    throw new Error('Unsafe error document or homepage fallback');
  const domain = domainFor(config, target);
  if (domain.AccessType !== 'DIRECT' || domain.Enable !== true)
    throw new Error('Unsupported hosting access type');
  const staticRoutes = domain.Routes.filter(
    (route) => route.UpstreamResourceType === 'STATIC_STORE',
  );
  if (
    staticRoutes.length !== 2 ||
    !['/', '/*'].every((path) => staticRoutes.some((route) => route.Path === path)) ||
    staticRoutes.some(
      (route) => route.Enable !== true || route.UpstreamResourceName !== 'staticstore',
    )
  )
    throw new Error('Static route ownership changed');
  const domainHeaders = domain.Extension?.HeadersHandler;
  const hasDomainCache =
    (domainHeaders?.ResponseHeadersToAdd ?? []).some(
      (header) => header.Key.toLowerCase() === 'cache-control',
    ) ||
    (domainHeaders?.ResponseHeadersToRemove ?? []).some(
      (key) => key.toLowerCase() === 'cache-control',
    );
  if (hasDomainCache) {
    const additional = domain.Routes.filter(
      (route) => route.UpstreamResourceType !== 'STATIC_STORE',
    );
    if (additional.length > 1 || additional.some((route) => !isReviewedBlogRoute(route)))
      throw Error('Unreviewed route shares the domain cache policy');
    // This validates retained settings only. Cache mutation still checks the complete domain.
    assertStaticDomainCacheScope({ ...domain, Routes: staticRoutes });
  }
  for (const headers of hasDomainCache
    ? [domainHeaders]
    : staticRoutes.map((route) => route.Extension?.HeadersHandler)) {
    const cache =
      headers?.ResponseHeadersToAdd?.filter(
        (header) => header.Key.toLowerCase() === 'cache-control',
      ) ?? [];
    if (
      cache.length !== 1 ||
      cache[0].Action !== 'OVERWRITE_IF_EXISTS_OR_ADD' ||
      (headers?.ResponseHeadersToRemove ?? []).some((key) => key.toLowerCase() === 'cache-control')
    )
      throw new Error('Unproven static cache configuration');
    assertMutableCachePolicy(cache[0].Value);
  }
}
function domainFor(config, target) {
  const domains = config.gateway.Domains.filter(
    (domain) => domain.Domain === new URL(target.site).hostname,
  );
  if (domains.length !== 1 || !Array.isArray(domains[0].Routes))
    throw new Error('Hosting domain identity mismatch');
  return domains[0];
}

/** Provider calls are incremental. Exact-before checks are not a provider-side compare-and-swap. */
export function validateConfigurationChange({ change, current, target }) {
  if (
    configurationStateHash(current) !== change.beforeHash ||
    configurationStateHash(change.before) !== change.beforeHash ||
    configurationStateHash(change.after) !== change.afterHash
  )
    throw new Error('Configuration source changed');
  const expected = copy(hostingConfigurationIdentity(current));
  if (change.kind === 'website') {
    expected.website.WebsiteConfiguration = copy(change.after.website.WebsiteConfiguration);
    const doc = expected.website.WebsiteConfiguration;
    if (
      doc.ErrorDocument?.Key !== errorDocumentPath ||
      doc.ErrorDocument?.OriginalHttpStatus !== 'Enabled' ||
      doc.ErrorDocument?.Charity404 === 'Enabled' ||
      doc.IndexDocument.Suffix !== 'index.html' ||
      (doc.RoutingRules ?? []).some((rule) => rule.Condition.HttpErrorCodeReturnedEquals) ||
      !same(change.args, websiteArguments(doc))
    )
      throw new Error('Unsafe website patch');
  } else if (change.kind === 'domain-headers') {
    const beforeDomain = domainFor(expected, target);
    const afterDomain = domainFor(change.after, target);
    assertStaticDomainCacheScope(beforeDomain);
    if (
      change.args.EnvId !== target.envId ||
      change.args.Domain.Domain !== new URL(target.site).hostname ||
      Object.keys(change.args).sort().join() !== 'Domain,EnvId' ||
      Object.keys(change.args.Domain).sort().join() !== 'Domain,Extension'
    )
      throw new Error('Invalid domain header patch target');
    if (!same(afterDomain.Extension, change.args.Domain.Extension))
      throw new Error('Domain header patch differs from expected state');
    beforeDomain.Extension = copy(change.args.Domain.Extension);
    assertSafeConfiguration(expected, target);
  } else throw new Error('Unsupported configuration mutation');
  if (configurationStateHash(expected) !== change.afterHash)
    throw new Error('Patch would change unmanaged configuration');
  return copy(change.args);
}
