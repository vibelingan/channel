import type { CatalogFamilyContent } from '../../i18n/catalog.ts';
import {
  type CatalogBreadcrumb,
  catalogBreadcrumbSchema,
  familyBreadcrumbs,
} from '../catalog-seo.ts';
import {
  type PageDescriptor,
  canonicalPath,
  createPageDescriptor,
  serializePageDescriptor,
} from './page.ts';

export interface CategoryPageIdentity {
  page: PageDescriptor;
  heading: string;
  breadcrumbs: CatalogBreadcrumb[];
}
export interface CategoryPageMetadata {
  current: CategoryPageIdentity;
  root: CategoryPageIdentity;
}

export function categoryPageIdentity(
  family: CatalogFamilyContent,
  data: { page: number; pageCount: number; path: string; revision: string },
  brand: string,
  origin: string | URL,
): CategoryPageIdentity {
  const suffix = data.page > 1 ? ` — Page ${data.page}` : '';
  const breadcrumbs = familyBreadcrumbs(family.heading, family.href);
  if (data.page > 1) breadcrumbs.push({ label: `Page ${data.page}`, href: data.path });
  return {
    heading: `${family.heading}${suffix}`,
    breadcrumbs,
    page: createPageDescriptor({
      path: data.path,
      kind: 'collection',
      title: `${data.page > 1 ? `${family.label}${suffix}` : family.seoTitle} | ${brand}`,
      description:
        data.page > 1
          ? `${family.description} Page ${data.page} of ${data.pageCount}.`
          : family.seoDescription,
      content: { source: 'public-catalog-category', revision: data.revision },
      schemaNodes: [catalogBreadcrumbSchema(breadcrumbs, origin)],
    }),
  };
}

/** Update only this catalog document's identity; preserve typed text, focus and global schemas. */
export function syncCategoryPageMetadata(document: Document, metadata: CategoryPageMetadata) {
  const identity =
    canonicalPath(document.location.pathname) === metadata.current.page.canonicalPath
      ? metadata.current
      : metadata.root;
  const { page, heading, breadcrumbs } = identity;
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) return;
  const url = new URL(page.canonicalPath, canonical.href).href;
  document.title = page.title;
  canonical.href = url;
  for (const [selector, value] of [
    ['meta[name="description"]', page.description],
    ['meta[property="og:title"]', page.title],
    ['meta[property="og:description"]', page.description],
    ['meta[property="og:url"]', url],
    ['meta[name="twitter:title"]', page.title],
    ['meta[name="twitter:description"]', page.description],
  ])
    document.querySelector(selector)?.setAttribute('content', value);
  const descriptor = document.getElementById('channel-page-descriptor');
  if (descriptor) descriptor.textContent = serializePageDescriptor(page);
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'head script[type="application/ld+json"]',
  )) {
    const graph: unknown = JSON.parse(script.textContent ?? '{}');
    if (
      !graph ||
      typeof graph !== 'object' ||
      !('@graph' in graph) ||
      !Array.isArray(graph['@graph'])
    )
      continue;
    graph['@graph'] = graph['@graph']
      .flatMap((node: Record<string, unknown>) => {
        if (node['@type'] === 'BreadcrumbList') return [];
        return [
          node['@type'] === 'WebPage'
            ? {
                ...node,
                '@id': `${url}#webpage`,
                url,
                name: page.title,
                description: page.description,
              }
            : node,
        ];
      })
      .concat(page.schemaNodes.filter((node) => node['@type'] === 'BreadcrumbList'));
    script.textContent = JSON.stringify(graph).replaceAll('<', '\\u003c');
  }
  const title = document.querySelector('[data-catalog-page-heading]');
  if (title) title.textContent = heading;
  document.querySelector('[data-catalog-page-section]')?.setAttribute('aria-label', heading);
  const navigation = document.querySelector('[data-catalog-page-breadcrumbs]');
  if (navigation) {
    const nodes: Node[] = [];
    for (const [index, breadcrumb] of breadcrumbs.entries()) {
      if (index < breadcrumbs.length - 1) {
        const link = document.createElement('a');
        link.href = breadcrumb.href;
        link.textContent = breadcrumb.label;
        link.className = 'hover:text-brand-700';
        const separator = document.createElement('span');
        separator.setAttribute('aria-hidden', 'true');
        separator.className = 'px-2';
        separator.textContent = '/';
        nodes.push(link, separator);
      } else {
        const current = document.createElement('span');
        current.textContent = breadcrumb.label;
        current.setAttribute('aria-current', 'page');
        nodes.push(current);
      }
    }
    navigation.replaceChildren(...nodes);
  }
}
