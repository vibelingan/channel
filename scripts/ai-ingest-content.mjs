#!/usr/bin/env node
/**
 * Ingest the website's own content into the assistant's AnythingLLM workspace.
 *
 * The corpus is deliberately the SAME content the site renders. Answers must
 * agree with the page a visitor can open, and the only way to guarantee that is
 * to ground them in the identical source rather than a hand-written FAQ that
 * drifts from the site the first time marketing edits a heading.
 *
 * The content files are structured YAML, not prose. Embedding raw YAML works
 * badly — punctuation and key names dominate the vector — so this flattens the
 * tree into readable statements that keep every fact and drop the syntax.
 *
 *   node scripts/ai-ingest-content.mjs            # upload
 *   node scripts/ai-ingest-content.mjs --dry-run  # print what would be sent
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { refreshCorpus } from './ai-corpus-refresh.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(repoRoot, 'apps/site/src/i18n/content');
const PAGES_DIR = join(repoRoot, 'apps/site/src/pages');

/** Each source file, and the page a visitor would open to read the same thing. */
const SOURCES = [
  { file: 'en-US.md', title: 'Company overview and homepage', url: '/' },
  { file: 'oem/en-US.md', title: 'OEM development service and process', url: '/oem' },
  { file: 'headphones/en-US.md', title: 'Headphones product line', url: '/headphones' },
  { file: 'portfolio/en-US.md', title: 'Success stories and case studies', url: '/portfolio' },
];

/**
 * Which routes the website actually publishes, read from the router itself.
 *
 * Astro does not route a file whose name begins with `_`. `_overstock.astro` is
 * deliberately unrouted and `apps/site/src/i18n/hidden-sections.test.ts` exists
 * to keep it that way — yet this manifest listed `overstock/en-US.md` against
 * the URL `/overstock`, so the assistant would have quoted an unpublished page
 * and cited a link that answers 404 in production. Grounding an answer in
 * content the visitor cannot open is a leak with a footnote.
 *
 * Derived, never hand-maintained: a hand-kept second list is exactly what drifts.
 */
export function publishedRoutes(pagesDir = PAGES_DIR) {
  const routes = new Set();
  for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
    // Astro's own rule. Underscore means "not a route", for files and folders.
    if (entry.name.startsWith('_')) continue;
    if (entry.isDirectory()) {
      routes.add(`/${entry.name}`);
      continue;
    }
    const match = entry.name.match(/^(.+)\.(astro|md|mdx|html)$/);
    if (!match) continue;
    routes.add(match[1] === 'index' ? '/' : `/${match[1]}`);
  }
  return routes;
}

/**
 * Every ingested source must map to a route the site really serves.
 *
 * Throws rather than filtering: silently dropping a source would make the
 * assistant refuse questions the website answers, and nobody would know why.
 */
export function assertSourcesArePublished(sources = SOURCES, pagesDir = PAGES_DIR) {
  const routes = publishedRoutes(pagesDir);
  const offenders = [];
  for (const source of sources) {
    if (!existsSync(join(CONTENT_DIR, source.file))) {
      offenders.push(`${source.file} -> ${source.url} (content file is missing)`);
      continue;
    }
    if (!routes.has(source.url)) {
      offenders.push(`${source.file} -> ${source.url} (no published route serves this URL)`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `refusing to ingest unpublished content:\n${offenders.map((o) => `  - ${o}`).join('\n')}\nA source the site does not serve must not become a citation. Remove it, or publish the page.`,
    );
  }
  return sources;
}

/** Keys that carry layout or asset wiring rather than anything a visitor asks about. */
const NOISE_KEYS = new Set([
  'icon',
  'logo',
  'logos',
  'clientLogos',
  'logoInitials',
  'dir',
  'locale',
  'href',
  'id',
  'productId',
  'image',
  'imageAlt',
  'img',
  'src',
  'alt',
  'slug',
  'emphasis',
  'mode',
  'badge',
  'variant',
  'poster',
  'posterHeight',
  'posterWidth',
  'filingNumber',
  'filingUrl',
  'nav',
  'meta',
  'seo',
  'statusAvailable',
  'statusLow',
  'statusSoldOut',
]);

/**
 * UI chrome follows a naming convention in these files: a key ending in
 * `Label`, `Cta`, or `Nav` holds text for a control, not an answer. `moqLabel`
 * is the string "MOQ" — a table heading — while the actual MOQ lives in a
 * `proof` or `detail` value. Embedding the headings made a question about
 * minimum order match a page of button captions.
 */
const CHROME_KEY = /(label|cta|nav|button|btn)s?$/i;

function isNoiseKey(key) {
  return NOISE_KEYS.has(key) || (key !== 'label' && CHROME_KEY.test(key));
}

function humanize(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
}

/**
 * Walk the YAML tree and emit one readable line per fact.
 *
 * Objects that look like a record ({title, desc}) collapse into "Title — desc"
 * rather than two separate lines, because splitting them strands the
 * description from the thing it describes once the text is chunked.
 */
function flatten(node, trail, out) {
  if (node == null) return;

  if (typeof node !== 'object') {
    const text = String(node).trim();
    if (!text) return;
    out.push(trail.length ? `${trail.join(' → ')}: ${text}` : text);
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) flatten(item, trail, out);
    return;
  }

  const label = node.title ?? node.label ?? node.name ?? node.heading;
  const detail = node.desc ?? node.description ?? node.text ?? node.body;
  if (typeof label === 'string' && typeof detail === 'string') {
    out.push(`${trail.join(' → ')}${trail.length ? ': ' : ''}${label} — ${detail}`);
    for (const [k, v] of Object.entries(node)) {
      if (['title', 'label', 'name', 'heading', 'desc', 'description', 'text', 'body'].includes(k))
        continue;
      if (isNoiseKey(k)) continue;
      flatten(v, [...trail, label, humanize(k)], out);
    }
    return;
  }

  for (const [k, v] of Object.entries(node)) {
    if (isNoiseKey(k)) continue;
    flatten(v, [...trail, humanize(k)], out);
  }
}

/**
 * These files are frontmatter documents: a YAML block fenced by `---`, then a
 * markdown body that is only an editing note. Everything a visitor reads lives
 * in the frontmatter, so take exactly that block and ignore the rest.
 */
export function frontmatterOf(fileText) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(fileText);
  if (!match) throw new Error('no YAML frontmatter block found');
  return match[1];
}

export function contentToText(yamlText, source) {
  const parsed = parseYaml(frontmatterOf(yamlText));
  const lines = [];
  flatten(parsed, [], lines);

  const seen = new Set();
  const unique = lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });

  return [
    `# ${source.title}`,
    `Source page: ${source.url}`,
    'Company: Diversity Technology Limited',
    '',
    ...unique,
  ].join('\n');
}

/**
 * Facts that a customer asks about directly, paired with the question they
 * actually type.
 *
 * Retrieval matches a question against text, and page copy is written to be
 * SCANNED, not asked. "Since 2004 · Hong Kong · Dongguan" is a perfectly good
 * banner and a poor match for "how long have you been in business?" — which is
 * exactly the miss this fixes: the fact was in the corpus and never retrieved.
 *
 * Every value is read from the same content files the site renders, so this
 * cannot drift into a second source of truth. A missing path is a hard error
 * rather than a silently dropped fact.
 */
const KEY_FACTS = [
  {
    path: ['hero', 'eyebrow'],
    questions: [
      'How long have you been in business?',
      'When was the company founded?',
      'Where are you based? Where is your factory?',
    ],
  },
  { path: ['brand', 'minOrder'], questions: ['What is your minimum order?', 'What is the MOQ?'] },
  { path: ['brand', 'tagline'], questions: ['What kind of company are you? What do you do?'] },
  { path: ['brand', 'name'], questions: ['What is your company name?'] },
];

function valueAt(tree, path) {
  return path.reduce((node, key) => (node == null ? undefined : node[key]), tree);
}

export function keyFactsDocument(homeYaml) {
  const parsed = parseYaml(frontmatterOf(homeYaml));
  const lines = ['# Key company facts', 'Source page: /', ''];
  const missing = [];

  for (const fact of KEY_FACTS) {
    const value = valueAt(parsed, fact.path);
    if (typeof value !== 'string' || !value.trim()) {
      missing.push(fact.path.join('.'));
      continue;
    }
    for (const question of fact.questions) lines.push(`${question} ${value.trim()}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `content no longer has: ${missing.join(', ')}. Update KEY_FACTS in this script — silently dropping these makes the assistant refuse questions the website answers.`,
    );
  }
  return lines.join('\n');
}

function legacyDocumentNames() {
  const names = ['key-facts-home'];
  for (const source of SOURCES) {
    names.push(`${basename(source.file, '.md')}-${source.url.replace(/\W+/g, '') || 'home'}`);
  }
  return names;
}

async function api(base, key, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/**
 * Confirm every citation target is live on the configured first-party origin,
 * BEFORE the first byte is uploaded.
 *
 * Ordering is the whole point. Checking as we upload would leave a corpus that
 * is half the new generation and half the old one, which is the state the
 * generation swap exists to make impossible. A failure here costs nothing
 * because nothing has been written yet.
 *
 * Cross-origin targets are refused rather than fetched: a manifest URL that
 * resolves somewhere else is the bug, not something to go and validate.
 */
export async function preflightPublicTargets(sources, siteOrigin, fetchImpl = fetch) {
  const origin = new URL(siteOrigin);
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost') {
    throw new Error(`SITE_ORIGIN must be https (or localhost), got: ${siteOrigin}`);
  }
  const failures = [];
  const checked = [];
  for (const url of [...new Set(sources.map((source) => source.url))]) {
    const target = new URL(url, origin);
    if (target.origin !== origin.origin) {
      failures.push(`${url} resolves to ${target.origin}, not the configured site`);
      continue;
    }
    let status;
    try {
      const res = await fetchImpl(target.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
    } catch (caught) {
      failures.push(
        `${url} could not be reached (${caught instanceof Error ? caught.message : 'unknown'})`,
      );
      continue;
    }
    // 200 only. A redirect means the citation would land somewhere other than
    // the page the answer was grounded in.
    if (status !== 200) failures.push(`${url} returned HTTP ${status}`);
    else checked.push(target.toString());
  }
  if (failures.length > 0) {
    throw new Error(
      `refusing to ingest; these citation targets are not live on ${origin.origin}:\n${failures.map((f) => `  - ${f}`).join('\n')}\nNothing was uploaded, so the previous corpus is still serving.`,
    );
  }
  return checked;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const base = process.env.ANYTHINGLLM_LOCAL_ADMIN_URL ?? 'http://127.0.0.1:53001';
  const workspace_ =
    process.env.ANYTHINGLLM_WORKSPACE_SLUG ??
    process.env.ANYTHINGLLM_WORKSPACE ??
    'channel-public-assistant';
  const key = process.env.ANYTHINGLLM_API_KEY;
  if (!key && !dryRun) throw new Error('ANYTHINGLLM_API_KEY is not set');

  // Two gates, both before any upload: the manifest may only name routes the
  // router publishes, and each of those routes must actually answer 200 now.
  assertSourcesArePublished();

  const docs = SOURCES.map((source) => ({
    source,
    text: contentToText(readFileSync(join(CONTENT_DIR, source.file), 'utf8'), source),
  }));

  docs.unshift({
    source: { file: 'key-facts', title: 'Key company facts', url: '/' },
    text: keyFactsDocument(readFileSync(join(CONTENT_DIR, 'en-US.md'), 'utf8')),
  });

  if (dryRun) {
    for (const { source, text } of docs) {
      console.log(
        `\n${'='.repeat(70)}\n${source.file}  (${text.split('\n').length} lines)\n${'='.repeat(70)}`,
      );
      console.log(text.split('\n').slice(0, 25).join('\n'));
      console.log('  …');
    }
    return;
  }

  // Last gate before anything is written: every page a citation will point at
  // must answer 200 on the real site right now. Deliberately after the dry-run
  // return — a dry run must not depend on the network — and before the client
  // is even built, so a failure cannot leave a half-swapped corpus.
  const siteOrigin = process.env.SITE_ORIGIN;
  if (!siteOrigin) {
    throw new Error(
      'SITE_ORIGIN is not set. Every citation resolves against it, and an ingest ' +
        'that cannot check its targets is an ingest that can publish dead links.',
    );
  }
  const verified = await preflightPublicTargets(SOURCES, siteOrigin);
  console.log(`preflight: ${verified.length} public page(s) live on ${new URL(siteOrigin).origin}`);

  // The swap algorithm lives in ai-corpus-refresh.mjs behind an injectable
  // client, so rollback, migration and generation cleanup are covered by
  // deterministic tests rather than by whatever a live run happened to do.
  const client = {
    listAttached: async () => {
      const workspace = await api(base, key, `/api/v1/workspace/${workspace_}`);
      return (workspace.workspace?.[0]?.documents ?? [])
        .map((document) => document.docpath)
        .filter(Boolean);
    },
    upload: async (document) => {
      const body = await api(base, key, '/api/v1/document/raw-text', {
        method: 'POST',
        body: JSON.stringify({
          textContent: document.text,
          metadata: {
            title: document.title,
            docSource: document.docSource,
            description: document.description,
          },
        }),
      });
      return body.documents?.[0]?.location;
    },
    attach: async (paths) => {
      await api(base, key, `/api/v1/workspace/${workspace_}/update-embeddings`, {
        method: 'POST',
        body: JSON.stringify({ adds: paths }),
      });
    },
    detach: async (paths) => {
      await api(base, key, `/api/v1/workspace/${workspace_}/update-embeddings`, {
        method: 'POST',
        body: JSON.stringify({ deletes: paths }),
      });
    },
    destroy: async (paths) => {
      await api(base, key, '/api/v1/system/remove-documents', {
        method: 'DELETE',
        body: JSON.stringify({ names: paths }),
      });
    },
    search: async (query) => {
      const probe = await api(base, key, `/api/v1/workspace/${workspace_}/vector-search`, {
        method: 'POST',
        body: JSON.stringify({ query, topN: 8, scoreThreshold: 0 }),
      });
      return (probe.results ?? []).map((result) => ({
        source: String(
          result?.metadata?.docpath ??
            result?.metadata?.title ??
            result?.metadata?.chunkSource ??
            '',
        ),
      }));
    },
  };

  await refreshCorpus({
    client,
    documents: docs.map(({ source, text }) => ({
      name: `${basename(source.file, '.md')}-${source.url.replace(/\W+/g, '') || 'home'}`,
      text,
      docSource: source.url,
      description: source.title,
    })),
    legacyNames: legacyDocumentNames(),
    verifyQuery: 'minimum order quantity',
    log: (message) => console.log(message),
  });
}

if (process.argv[1]?.endsWith('ai-ingest-content.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
