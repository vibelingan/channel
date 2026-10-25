const domain = 'supplychainsai.com';
const paths = ['/blog', '/blog/*'];
const own = (route) =>
  paths.includes(route.Path) &&
  route.UpstreamResourceType === 'CBR' &&
  route.UpstreamResourceName === 'blog-pages' &&
  route.EnablePathTransmission === true &&
  route.EnableAuth === false;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !['CreateTime', 'UpdateTime'].includes(key))
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
function fixed(routes) {
  return JSON.stringify(
    stable(
      routes
        .filter((route) => !paths.includes(route.Path))
        .toSorted((a, b) => a.Path.localeCompare(b.Path)),
    ),
  );
}
/** Only the two Blog paths are writable. Unknown routes and unrelated configuration stop the change. */
export async function setBlogRoutes({ client, action, save, verify }) {
  if (!['initialize', 'restore'].includes(action))
    throw Error('Explicit Blog route action required');
  async function read() {
    const result = await client.call('queryGateway', { action: 'listRoutes', domain });
    const domains = result.data?.raw?.Domains;
    if (
      !Array.isArray(domains) ||
      domains.length !== 1 ||
      domains[0].Domain !== domain ||
      domains[0].DomainType !== 'HTTPSERVICE' ||
      domains[0].Enable !== true ||
      !Array.isArray(domains[0].Routes)
    )
      throw Error('Complete existing domain configuration required');
    const site = domains[0];
    return { routes: site.Routes, rest: JSON.stringify(stable({ ...site, Routes: undefined })) };
  }
  const before = await read();
  for (const route of before.routes.filter((route) => paths.includes(route.Path)))
    if (!own(route)) throw Error('A Blog path belongs to another upstream; no route changed');
  if (
    !before.routes.some(
      (route) =>
        route.Path === '/' &&
        route.UpstreamResourceType === 'STATIC_STORE' &&
        route.Enable === true,
    )
  )
    throw Error('The existing website must remain enabled');
  await save({ phase: 'before', domain, action, configuration: before });
  const unchanged = async () => {
    const current = await read();
    if (current.rest !== before.rest || fixed(current.routes) !== fixed(before.routes))
      throw Error('Unrelated domain configuration changed; no further write allowed');
    return current;
  };
  for (const path of paths) {
    const current = await unchanged();
    const route = current.routes.find((item) => item.Path === path);
    if (route && !own(route)) throw Error('Blog route changed owner');
    if (action === 'restore' && !route) continue;
    const enable = action === 'initialize';
    if (route?.Enable === enable) continue;
    await save({ phase: 'intent', domain, path, enable, existed: Boolean(route) });
    try {
      await client.call(
        'manageGateway',
        route
          ? { action: enable ? 'enableRoute' : 'disableRoute', domain, path }
          : {
              action: 'createRoute',
              domain,
              path,
              upstreamResourceType: 'CBR',
              targetName: 'blog-pages',
              enable: true,
              auth: false,
              enableSafeDomain: false,
              enablePathTransmission: true,
            },
      );
    } catch {
      // Resolve a lost acknowledgement from the real route. Do not repeat the write.
    }
    const after = await unchanged();
    const actual = after.routes.find((item) => item.Path === path);
    if (!actual || !own(actual) || actual.Enable !== enable)
      throw Error('The requested Blog route was not confirmed; inspect the saved intent');
    await save({ phase: 'confirmed', domain, path, enable });
  }
  await verify();
  await save({ phase: 'accepted', domain, action, configuration: await unchanged() });
}
