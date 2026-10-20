import { planHostingCacheChange } from '../hosting-cache-plan.mjs';
import { assertMutableCachePolicy } from '../hosting-contract.mjs';
import { hostingConfigurationIdentity } from '../hosting-recovery.mjs';
import { assertOrigin, freeze, sha256 } from './input.mjs';

export const configurationHash = (config) =>
  sha256(JSON.stringify(hostingConfigurationIdentity(config)));
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
      beforeHash: configurationHash(after),
      afterHash: configurationHash(next),
    });
    after = copy(next);
  };
  if (
    errorDocument !== undefined &&
    errorDocument !== source.website.WebsiteConfiguration.ErrorDocument?.Key
  ) {
    const next = copy(after);
    next.website.WebsiteConfiguration.ErrorDocument = {
      ...next.website.WebsiteConfiguration.ErrorDocument,
      Key: errorDocument,
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
    for (const route of args.Domain.Routes)
      route.Extension.HeadersHandler.ResponseHeadersToAdd.find(
        (h) => h.Key.toLowerCase() === 'cache-control',
      ).Value = cacheControl;
    const next = copy(after);
    const domain = domainFor(next, target);
    domain.Routes = domain.Routes.map((route) => {
      const changed = args.Domain.Routes.find((item) => item.Path === route.Path);
      return changed ? { ...route, Extension: changed.Extension } : route;
    });
    if (!same(after, next)) add('routes', args, next);
  }
  assertSafeConfiguration(after, target);
  return freeze({ schemaVersion: 1, target: copy(target), before: source, after, changes });
}

export function inverseHostingConfiguration({ plan, current }) {
  if (configurationHash(current) !== configurationHash(plan.after))
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
            Routes: change.args.Domain.Routes.map((item) => ({
              Path: item.Path,
              Extension: copy(
                prior.Routes.find((route) => route.Path === item.Path).Extension ?? {},
              ),
            })),
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
    website.ErrorDocument?.Key !== '404.html' ||
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
  for (const route of staticRoutes) {
    const headers = route.Extension?.HeadersHandler;
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
    configurationHash(current) !== change.beforeHash ||
    configurationHash(change.before) !== change.beforeHash ||
    configurationHash(change.after) !== change.afterHash
  )
    throw new Error('Configuration source changed');
  const expected = copy(hostingConfigurationIdentity(current));
  if (change.kind === 'website') {
    expected.website.WebsiteConfiguration = copy(change.after.website.WebsiteConfiguration);
    const doc = expected.website.WebsiteConfiguration;
    if (
      doc.ErrorDocument?.Key !== '404.html' ||
      doc.IndexDocument.Suffix !== 'index.html' ||
      (doc.RoutingRules ?? []).some((rule) => rule.Condition.HttpErrorCodeReturnedEquals) ||
      !same(change.args, websiteArguments(doc))
    )
      throw new Error('Unsafe website patch');
  } else if (change.kind === 'routes') {
    const beforeDomain = domainFor(expected, target);
    const afterDomain = domainFor(change.after, target);
    const paths = ['/', '/*'];
    if (
      change.args.EnvId !== target.envId ||
      change.args.Domain.Domain !== new URL(target.site).hostname ||
      Object.keys(change.args).sort().join() !== 'Domain,EnvId' ||
      Object.keys(change.args.Domain).sort().join() !== 'Domain,Routes' ||
      change.args.Domain.Routes.length !== 2
    )
      throw new Error('Invalid route patch target');
    for (const patch of change.args.Domain.Routes) {
      const original = beforeDomain.Routes.find((route) => route.Path === patch.Path);
      if (
        !paths.includes(patch.Path) ||
        Object.keys(patch).sort().join() !== 'Extension,Path' ||
        !original ||
        original.UpstreamResourceType !== 'STATIC_STORE' ||
        original.UpstreamResourceName !== 'staticstore' ||
        original.Enable !== true ||
        beforeDomain.AccessType !== 'DIRECT' ||
        beforeDomain.Enable !== true
      )
        throw new Error('Route ownership changed');
      const desired = afterDomain.Routes.find((route) => route.Path === patch.Path);
      if (!desired || !same(desired.Extension, patch.Extension))
        throw new Error('Route patch differs from expected state');
      original.Extension = copy(patch.Extension);
    }
    if (new Set(change.args.Domain.Routes.map((route) => route.Path)).size !== 2)
      throw new Error('Duplicate route patch');
    assertSafeConfiguration(expected, target);
  } else throw new Error('Unsupported configuration mutation');
  if (configurationHash(expected) !== change.afterHash)
    throw new Error('Patch would change unmanaged configuration');
  return copy(change.args);
}
