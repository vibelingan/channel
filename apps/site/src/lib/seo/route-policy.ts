import { canonicalPath, indexPolicy } from './page.ts';

const familyPaths = new Set(['/headphones/', '/ai-gadgets/', '/toys/', '/misc/']);

export function isSitemapPathIncluded(
  path: string,
  published: ReadonlySet<string> = familyPaths,
): boolean {
  const identity = canonicalPath(path);
  if (indexPolicy(identity) !== 'index,follow') return false;
  return (
    !familyPaths.has(identity) ||
    published.has(identity) ||
    published.has(identity.replace(/\/$/, ''))
  );
}

export function includeInSitemap(
  page: string,
  published: ReadonlySet<string> = familyPaths,
): boolean {
  const url = new URL(page);
  return !url.search && !url.hash && isSitemapPathIncluded(url.pathname, published);
}
