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

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(repoRoot, 'apps/site/src/i18n/content');

/** Each source file, and the page a visitor would open to read the same thing. */
const SOURCES = [
  { file: 'en-US.md', title: 'Company overview and homepage', url: '/' },
  { file: 'oem/en-US.md', title: 'OEM development service and process', url: '/oem' },
  { file: 'headphones/en-US.md', title: 'Headphones product line', url: '/headphones' },
  { file: 'portfolio/en-US.md', title: 'Success stories and case studies', url: '/portfolio' },
  { file: 'overstock/en-US.md', title: 'Overstock and ready stock', url: '/overstock' },
];

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

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const base = process.env.ANYTHINGLLM_BASE_URL ?? 'http://localhost:53001';
  const workspace = process.env.ANYTHINGLLM_WORKSPACE ?? 'channel-public-assistant';
  const key = process.env.ANYTHINGLLM_API_KEY;
  if (!key && !dryRun) throw new Error('ANYTHINGLLM_API_KEY is not set');

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

  // Re-ingest must replace, not accumulate. Without this, editing one heading
  // and re-running leaves both versions embedded and the assistant retrieves
  // whichever the vector search happens to prefer — a stale answer with a real
  // citation, which is the worst failure shape this product has.
  const existing = await api(base, key, `/api/v1/workspace/${workspace}`);
  const stale = (existing.workspace?.[0]?.documents ?? []).map((d) => d.docpath).filter(Boolean);
  if (stale.length > 0) {
    await api(base, key, `/api/v1/workspace/${workspace}/update-embeddings`, {
      method: 'POST',
      body: JSON.stringify({ deletes: stale }),
    });
    console.log(`removed ${stale.length} previously embedded document(s)`);
  }

  const uploadedLocations = [];
  for (const { source, text } of docs) {
    const res = await fetch(`${base}/api/v1/document/raw-text`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        textContent: text,
        metadata: {
          title: `${basename(source.file, '.md')}-${source.url.replace(/\W+/g, '') || 'home'}.txt`,
          docSource: source.url,
          description: source.title,
        },
      }),
    });
    const body = await res.json();
    if (!res.ok || body.error)
      throw new Error(`upload failed for ${source.file}: ${JSON.stringify(body).slice(0, 300)}`);
    const location = body.documents?.[0]?.location;
    if (!location) throw new Error(`no document location returned for ${source.file}`);
    uploadedLocations.push(location);
    console.log(`uploaded  ${source.file}  →  ${location}`);
  }

  // Uploading only parks a document in the system; a workspace only retrieves
  // what has been explicitly embedded into it.
  const res = await fetch(`${base}/api/v1/workspace/${workspace}/update-embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ adds: uploadedLocations }),
  });
  const body = await res.json();
  if (!res.ok || body.error)
    throw new Error(`embedding failed: ${JSON.stringify(body).slice(0, 300)}`);
  console.log(`\nembedded ${uploadedLocations.length} document(s) into "${workspace}"`);
}

if (process.argv[1]?.endsWith('ai-ingest-content.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
