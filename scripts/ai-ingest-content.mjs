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

/** Marks documents this script owns, and which run created them. */
const DOCUMENT_NAMESPACE = 'channelkb';
const OWNED_DOCUMENT = new RegExp(`${DOCUMENT_NAMESPACE}-g(\\d+)-`);

/**
 * Documents this script uploaded BEFORE the namespace existed.
 *
 * Without this the first namespaced run treats them as somebody else's, leaves
 * them attached, and the workspace ends up holding two copies of every page.
 * Observed: 12 documents where there should be 6, and the duplication pushed
 * the MOQ fact out of the top results — the assistant stopped answering a
 * question the website answers. Recognising them by the exact names this
 * script generated is precise enough to migrate them without touching a
 * document a person attached by hand.
 */
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

  // GENERATION SWAP, not delete-then-upload.
  //
  // The previous order deleted every attached document first and only then
  // uploaded replacements. A failure at upload or embed — a network blip, a
  // rejected document, an interrupted run — left the assistant with NO corpus
  // and no error: it would keep answering, ungrounded, until someone noticed.
  //
  // Now the new generation is uploaded and embedded alongside the old one, and
  // the old one is removed only after the new one is verified. A failure at any
  // earlier point rolls the partial generation back and leaves the corpus
  // exactly as it was.
  const generation = Date.now();
  const legacy = legacyDocumentNames();
  const owned = (docpath) => {
    // Compared lower-cased: the engine slugs the title it is given, so
    // `en-US.md` becomes `raw-en-us-home-…`. Matching case-sensitively left
    // five of twelve stale documents attached and the corpus still duplicated.
    const path = String(docpath ?? '').toLowerCase();
    if (OWNED_DOCUMENT.test(path)) return true;
    // Pre-namespace uploads: `custom-documents/raw-<name>-<uuid>.json`.
    return legacy.some((name) => path.includes(`raw-${name.toLowerCase()}-`));
  };
  const generationOf = (docpath) => Number(OWNED_DOCUMENT.exec(String(docpath ?? ''))?.[1] ?? 0);

  const before = await api(base, key, `/api/v1/workspace/${workspace}`);
  const attachedBefore = (before.workspace?.[0]?.documents ?? [])
    .map((document) => document.docpath)
    .filter(Boolean);
  const previousGeneration = attachedBefore.filter(owned);
  const foreign = attachedBefore.filter((docpath) => !owned(docpath));
  if (foreign.length > 0) {
    // Someone attached documents by hand through the engine's own UI. They are
    // not ours to delete.
    console.log(`leaving ${foreign.length} document(s) this script does not own`);
  }

  const uploadedLocations = [];

  /** Undo a partial generation so a failure never costs the corpus. */
  async function rollback(reason) {
    if (uploadedLocations.length === 0) return;
    console.error(`\n${reason}\nrolling back ${uploadedLocations.length} uploaded document(s)…`);
    // Detach and delete are attempted INDEPENDENTLY. Chaining them meant a
    // failed detach — which is exactly what happens when the workspace itself
    // is the problem — skipped the delete and left the uploads orphaned in
    // storage forever.
    const detached = await api(base, key, `/api/v1/workspace/${workspace}/update-embeddings`, {
      method: 'POST',
      body: JSON.stringify({ deletes: uploadedLocations }),
    })
      .then(() => true)
      .catch(() => false);

    const deleted = await api(base, key, '/api/v1/system/remove-documents', {
      method: 'DELETE',
      body: JSON.stringify({ names: uploadedLocations }),
    })
      .then(() => true)
      .catch(() => false);

    if (detached && deleted) {
      console.error('rolled back; the previous corpus is untouched');
    } else {
      console.error(
        `rollback incomplete (detached=${detached}, deleted=${deleted}); the previous corpus is still attached and still serving. Re-run to replace it.`,
      );
    }
  }

  try {
    for (const { source, text } of docs) {
      const res = await fetch(`${base}/api/v1/document/raw-text`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textContent: text,
          metadata: {
            // The generation tag rides in the title, which becomes part of the
            // docpath — so ownership and vintage are both readable from the
            // path alone, with no side table to keep in step.
            title: `${DOCUMENT_NAMESPACE}-g${generation}-${basename(source.file, '.md')}-${source.url.replace(/\W+/g, '') || 'home'}.txt`,
            docSource: source.url,
            description: source.title,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        throw new Error(`upload failed for ${source.file}: ${JSON.stringify(body).slice(0, 300)}`);
      }
      const location = body.documents?.[0]?.location;
      if (!location) throw new Error(`no document location returned for ${source.file}`);
      uploadedLocations.push(location);
      console.log(`uploaded  ${source.file}`);
    }

    // Uploading only parks a document in the system; a workspace only retrieves
    // what has been explicitly embedded into it.
    await api(base, key, `/api/v1/workspace/${workspace}/update-embeddings`, {
      method: 'POST',
      body: JSON.stringify({ adds: uploadedLocations }),
    });

    // VERIFY BEFORE REMOVING. Embedding reporting success is not the same as
    // the documents being attached and retrievable.
    const after = await api(base, key, `/api/v1/workspace/${workspace}`);
    const attachedAfter = (after.workspace?.[0]?.documents ?? [])
      .map((document) => document.docpath)
      .filter(Boolean);
    const missing = uploadedLocations.filter((location) => !attachedAfter.includes(location));
    if (missing.length > 0) {
      throw new Error(`${missing.length} document(s) did not attach to the workspace`);
    }

    const probe = await api(base, key, `/api/v1/workspace/${workspace}/vector-search`, {
      method: 'POST',
      body: JSON.stringify({ query: 'minimum order quantity', topN: 3, scoreThreshold: 0 }),
    });
    if (!Array.isArray(probe.results) || probe.results.length === 0) {
      throw new Error('the new corpus embedded but retrieved nothing');
    }
    console.log(`\nembedded and verified ${uploadedLocations.length} document(s)`);
  } catch (error) {
    await rollback(error.message);
    throw error;
  }

  // Only now is the old generation safe to remove.
  const superseded = previousGeneration.filter(
    (docpath) => generationOf(docpath) !== generation && !uploadedLocations.includes(docpath),
  );
  if (superseded.length > 0) {
    await api(base, key, `/api/v1/workspace/${workspace}/update-embeddings`, {
      method: 'POST',
      body: JSON.stringify({ deletes: superseded }),
    });
    await api(base, key, '/api/v1/system/remove-documents', {
      method: 'DELETE',
      body: JSON.stringify({ names: superseded }),
    }).catch(() => undefined);
    console.log(`removed ${superseded.length} superseded document(s)`);
  }
}

if (process.argv[1]?.endsWith('ai-ingest-content.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
