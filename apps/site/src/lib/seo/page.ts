export type RobotsPolicy = 'index,follow' | 'noindex,follow' | 'noindex,nofollow';
export type PageKind = 'marketing' | 'collection' | 'product' | 'article' | 'utility';

export interface PublicContentSource {
  source: string;
  revision?: string;
  updatedAt?: string;
}

export interface PageDescriptor {
  kind: PageKind;
  canonicalPath: string;
  robots: RobotsPolicy;
  title: string;
  description: string;
  content: PublicContentSource;
  schemaNodes: Record<string, unknown>[];
}

interface PageInput {
  path: string;
  kind?: PageKind;
  canonicalPath?: string;
  robots?: RobotsPolicy;
  title: string;
  description: string;
  content?: PublicContentSource;
  schemaNodes?: Record<string, unknown>[];
}

const PRIVATE_ROOTS = [
  '/admin',
  '/account',
  '/login',
  '/register',
  '/reset',
  '/api',
  '/__blog-dummy',
];
const FOLLOW_SHELLS = new Set(['/products/item/', '/success-stories/', '/404/', '/404.html']);

export function canonicalPath(input: string): string {
  const path = input.split(/[?#]/, 1)[0];
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\\s]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error(`Invalid canonical path: ${input}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Invalid canonical encoding: ${input}`);
  }
  if (
    decoded.split('/').some((part) => part === '.' || part === '..') ||
    /[\\?#]/.test(decoded) ||
    decoded.includes('//')
  ) {
    throw new Error(`Ambiguous canonical path: ${input}`);
  }
  const normalized = path.replace(/\/+$/, '') || '/';
  return normalized === '/' || /\.[^/]+$/.test(normalized) ? normalized : `${normalized}/`;
}

export function siteOrigin(input: string | URL): string {
  const url = new URL(input);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'SITE_URL must be an HTTP(S) origin without a path, credentials, query or fragment.',
    );
  }
  return url.origin;
}

export function canonicalUrl(path: string, origin: string | URL): string {
  return new URL(canonicalPath(path), siteOrigin(origin)).href;
}

export function indexPolicy(input: string): RobotsPolicy {
  const path = decodeURIComponent(canonicalPath(input));
  if (
    PRIVATE_ROOTS.some((root) => path === `${root}/` || path.startsWith(`${root}/`)) ||
    path === '/oem_submit_result/'
  ) {
    return 'noindex,nofollow';
  }
  return FOLLOW_SHELLS.has(path) ? 'noindex,follow' : 'index,follow';
}

export function createPageDescriptor(input: PageInput): PageDescriptor {
  const path = canonicalPath(input.path);
  const requiredPolicy = indexPolicy(path);
  const robots = input.robots ?? requiredPolicy;
  if (requiredPolicy !== 'index,follow' && robots === 'index,follow') {
    throw new Error(`Route must stay noindex: ${path}`);
  }
  const kind = input.kind ?? (robots !== 'index,follow' ? 'utility' : 'marketing');
  if (robots === 'index,follow' && /^\/(products|blog)\/[^/]+/.test(path) && !input.kind) {
    throw new Error(`Content route requires an explicit page kind and public source: ${path}`);
  }
  if (!input.title.trim() || !input.description.trim())
    throw new Error(`Missing page metadata: ${path}`);
  const content = input.content ?? { source: 'site-content' };
  if (
    !content.source.trim() ||
    ((kind === 'product' || kind === 'article') && !content.revision?.trim())
  ) {
    throw new Error(`Public content source/revision required: ${path}`);
  }
  if (
    content.updatedAt &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(content.updatedAt) ||
      !Number.isFinite(Date.parse(content.updatedAt)))
  ) {
    throw new Error(`Invalid content updatedAt: ${path}`);
  }
  return {
    kind,
    canonicalPath: canonicalPath(input.canonicalPath ?? path),
    robots,
    title: input.title,
    description: input.description,
    content: { source: content.source, revision: content.revision, updatedAt: content.updatedAt },
    schemaNodes: input.schemaNodes ?? [],
  };
}

export function serializePageDescriptor(page: PageDescriptor): string {
  return JSON.stringify(page).replaceAll('<', '\\u003c');
}
