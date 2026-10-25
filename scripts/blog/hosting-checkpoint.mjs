import { configurationStateHash } from '../release/hosting-configuration.mjs';
/** Authorize only the already reviewed Blog prefix addition, never unrelated hosting changes. */
export function assertBlogConfigurationCheckpoint(saved, current, siteOrigin) {
  if (siteOrigin !== 'https://supplychainsai.com')
    throw Error('Fixed Blog checkpoint site required');
  const strip = (input, requireBlog) => {
    const config = structuredClone(input);
    const domains = config.gateway?.Domains;
    if (
      !Array.isArray(domains) ||
      domains.length !== 1 ||
      domains[0].Domain !== 'supplychainsai.com'
    )
      throw Error('Complete Blog checkpoint configuration required');
    const routes = domains[0].Routes;
    if (!Array.isArray(routes)) throw Error('Complete routes required');
    const blog = routes.filter((r) => r.Path === '/blog');
    if (blog.length > 1 || (requireBlog && blog.length !== 1))
      throw Error('One actual Blog route required');
    const allowed = new Set([
      'Path',
      'PathRewrite',
      'UpstreamResourceType',
      'UpstreamResourceName',
      'EnableSafeDomain',
      'EnableAuth',
      'EnablePathTransmission',
      'QPSPolicy',
      'Enable',
      'CreateTime',
      'UpdateTime',
    ]);
    for (const r of blog) {
      if (
        r.UpstreamResourceType !== 'CBR' ||
        r.UpstreamResourceName !== 'blog-pages' ||
        r.Enable !== true ||
        r.EnableAuth !== false ||
        r.EnablePathTransmission !== true ||
        r.EnableSafeDomain !== false ||
        Object.keys(r).some((k) => !allowed.has(k)) ||
        Object.keys(r.PathRewrite ?? {}).length ||
        Object.keys(r.QPSPolicy ?? {}).length
      )
        throw Error('Blog route differs from its approved target and settings');
    }
    domains[0].Routes = routes.filter((r) => r.Path !== '/blog');
    return config;
  };
  const before = strip(saved, false);
  const after = strip(current, true);
  if (configurationStateHash(before) !== configurationStateHash(after))
    throw Error('An unrelated hosting setting changed; no checkpoint accepted');
}
