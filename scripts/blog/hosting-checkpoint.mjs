import { configurationStateHash } from '../release/hosting-configuration.mjs';
import { isReviewedBlogRoute } from './server-routes.mjs';
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
    if (blog.some((route) => !isReviewedBlogRoute(route) || route.Enable !== true))
      throw Error('Blog route differs from its approved target and settings');
    domains[0].Routes = routes.filter((r) => r.Path !== '/blog');
    return config;
  };
  const before = strip(saved, false);
  const after = strip(current, true);
  if (configurationStateHash(before) !== configurationStateHash(after))
    throw Error('An unrelated hosting setting changed; no checkpoint accepted');
}
