import { inspectPage } from './output-gate.ts';

/** The site's single wildcard group uses literal prefixes. New rule syntax needs review. */
export function projectRobotsAllows(text: string, path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\s\\]/.test(path))
    throw Error('Invalid project robots path');
  let groups = 0;
  const rules: { allow: boolean; prefix: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = line.split('#', 1)[0].trim();
    if (!entry) continue;
    const match = /^([a-z-]+):\s*(.*)$/i.exec(entry);
    if (!match) throw Error('Unsupported project robots syntax');
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      if (++groups !== 1 || value !== '*') throw Error('Unsupported project robots groups');
    } else if (key === 'sitemap') {
      if (!/^https?:\/\/[^\s]+$/.test(value)) throw Error('Invalid project robots sitemap');
    } else if (key === 'allow' || key === 'disallow') {
      if (groups !== 1 || (value && (!value.startsWith('/') || /[*$\s]/.test(value))))
        throw Error('Unsupported project robots rule');
      if (value) rules.push({ allow: key === 'allow', prefix: value });
    } else throw Error('Unsupported project robots directive');
  }
  if (groups !== 1) throw Error('Missing project robots group');
  const matching = rules.filter((rule) => path.startsWith(rule.prefix));
  matching.sort((a, b) => b.prefix.length - a.prefix.length || Number(b.allow) - Number(a.allow));
  return matching[0]?.allow ?? true;
}

/** A public sitemap URL must pass both HTTP and the existing initial-HTML contract. */
export async function assertIndexingResponse(input: {
  path: string;
  origin: string;
  status: number;
  headers: Headers;
  html: string;
  robots: string;
}) {
  if (input.status !== 200) throw Error(`Indexing HTTP ${input.status}`);
  if (!/^text\/html(?:;|$)/i.test(input.headers.get('content-type') ?? ''))
    throw Error('Indexing requires HTML');
  if (/\b(?:noindex|nofollow|none)\b/i.test(input.headers.get('x-robots-tag') ?? ''))
    throw Error('Indexing is blocked by the HTTP robots header');
  if (!projectRobotsAllows(input.robots, input.path))
    throw Error('Indexing is blocked by robots.txt');
  const page = await inspectPage(input.html, input.path, input.origin);
  if (page.robots !== 'index,follow') throw Error('Indexing is blocked by page metadata');
  return page;
}
