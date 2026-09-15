import {
  type CatalogContent,
  CatalogContentSchema,
  type CatalogNoteBlocks,
  CatalogNoteBlocksSchema,
} from '@vibelingan-channel/shared/catalog-detail';
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5';
import { sanitizeSourceHtml } from './descriptions.ts';

type Node = DefaultTreeAdapterMap['node'];
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const tag = (node: Node) => ('tagName' in node ? node.tagName : '');
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// Conservative routing, not a universal product attribute ontology.
const specificationNames = new Set([
  'productname',
  'material',
  'function',
  'driverssize',
  'driversize',
  'frequencyresponse',
  'sensitivity',
  'impedance',
  'headphonejack',
  'wire',
  'microphone',
  'weight',
  'dimensions',
  'model',
  'modelnumber',
  'connectivity',
  'bluetoothversion',
  'batterylife',
]);
const packagingNames = new Set([
  'package',
  'packaging',
  'packagecontents',
  'accessories',
  'inthebox',
  'packing',
  'packingsize',
  'packagesize',
  'cartonsize',
  'cartonquantity',
]);
const blockNames = new Set([
  'p',
  'div',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
  'tr',
]);
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
function nodeText(node: Node): string {
  if ('value' in node) return node.value;
  return children(node)
    .map(nodeText)
    .join(['td', 'th', 'tr'].includes(tag(node)) ? ' ' : '');
}
function withinBudget(root: Node): boolean {
  const queue = [{ node: root, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const item = queue.pop();
    if (!item) break;
    if (++count > 4000 || item.depth > 32) return false;
    for (const child of children(item.node)) queue.push({ node: child, depth: item.depth + 1 });
  }
  return true;
}

/** Shared by both providers. Parse once server-side; UI receives escaped text only.
 * Unsupported structure fails back to notes, never guesses alternating prose pairs.
 */
export function buildStructuredContent(input: unknown): {
  content?: CatalogContent;
  noteBlocks?: CatalogNoteBlocks;
  warnings: string[];
} {
  const warnings = new Set<string>();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { warnings: [] };
  if ('placeholder' in input && input.placeholder === true) return { warnings: [] };
  const html = 'sanitizedHtml' in input ? input.sanitizedHtml : undefined;
  const text = 'text' in input ? input.text : undefined;
  if (html !== undefined && typeof html !== 'string') return { warnings: ['invalid-content'] };
  const source =
    typeof html === 'string' && html.trim() ? html : typeof text === 'string' ? text : '';
  if (!source.trim()) return { warnings: [] };
  if (source.length > 64000) return { warnings: ['content-limit'] };
  try {
    const original = parseFragment(source);
    if (!withinBudget(original)) return { warnings: ['content-limit'] };
    // Inspect spans before the existing sanitizer strips all attributes. Retained
    // historical HTML may already have lost them; only explicit row pairs qualify.
    let ambiguousTables = false;
    const inspect = (node: Node, inTable = false) => {
      if (tag(node) === 'table' && inTable) ambiguousTables = true;
      const current = inTable || tag(node) === 'table';
      if (
        current &&
        'attrs' in node &&
        node.attrs.some((a) => ['colspan', 'rowspan'].includes(a.name) && a.value !== '1')
      )
        ambiguousTables = true;
      for (const child of children(node)) inspect(child, current);
    };
    inspect(original);
    // Plain text must not acquire markup semantics when no HTML was retained.
    const safe =
      typeof html === 'string' && html.trim()
        ? sanitizeSourceHtml(source)
        : source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tree = parseFragment(safe);
    if (!withinBudget(tree)) return { warnings: ['content-limit'] };
    const notes: string[] = [];
    const noteBlocks: CatalogNoteBlocks = [];
    const rows: { name: string; value: string; group: 'specifications' | 'packaging' }[] = [];
    // Explicit user-confirmed standalone titles recover headings whose source
    // formatting was lost upstream. Never infer headings by length/capitalization.
    const approvedStandaloneHeadings = new Set([
      'Experienced Headphones Manufacturer',
      'Product Description',
    ]);
    const note = (value: string, heading = false) => {
      const normalized = clean(value);
      if (normalized) {
        notes.push(normalized);
        noteBlocks.push({
          kind:
            (heading || approvedStandaloneHeadings.has(normalized)) && normalized.length <= 200
              ? 'heading'
              : 'paragraph',
          text: normalized,
        });
      }
    };
    const consumeTable = (table: Node) => {
      const descendants: Node[] = [];
      const collect = (node: Node) => {
        for (const child of children(node)) {
          descendants.push(child);
          collect(child);
        }
      };
      collect(table);
      const nestedCount = descendants.filter((n) => tag(n) === 'table').length;
      // Sanitization may remove entire tables; ordinal matching between the
      // two trees is unsafe. Any ambiguous original table conservatively keeps
      // all table content as notes in this observation.
      if (ambiguousTables || nestedCount) {
        warnings.add('ambiguous-table');
        note(nodeText(table));
        return;
      }
      for (const row of descendants.filter((n) => tag(n) === 'tr')) {
        const cells = children(row)
          .filter((n) => ['td', 'th'].includes(tag(n)))
          .map((n) => clean(nodeText(n)))
          .filter(Boolean);
        const [name, value] = cells;
        if (cells.length !== 2 || !name || !value || name.length > 200) {
          note(cells.join(' — '));
          continue;
        }
        const normalized = key(name);
        const group = specificationNames.has(normalized)
          ? 'specifications'
          : packagingNames.has(normalized)
            ? 'packaging'
            : undefined;
        if (group) rows.push({ name, value, group });
        else note(`${name} — ${value}`);
      }
    };
    let pending = '';
    const flush = () => {
      note(pending);
      pending = '';
    };
    const walk = (node: Node) => {
      if (/^h[1-6]$/.test(tag(node))) {
        flush();
        note(nodeText(node), true);
        return;
      }
      if (tag(node) === 'table') {
        flush();
        consumeTable(node);
        return;
      }
      const block = blockNames.has(tag(node));
      if (block) flush();
      if ('value' in node) pending += node.value;
      for (const child of children(node)) walk(child);
      if (block) flush();
    };
    walk(tree);
    flush();
    const content: CatalogContent = {
      schemaVersion: 'catalog-content-v1',
      specifications: [],
      packaging: [],
      notes,
    };
    const values = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = key(row.name);
      const found = values.get(id) ?? new Set<string>();
      found.add(row.value);
      values.set(id, found);
    }
    const emitted = new Set<string>();
    for (const { name, value, group } of rows) {
      const id = key(name);
      if ((values.get(id)?.size ?? 0) > 1) {
        warnings.add('conflicting-content-field');
        note(`${name} — ${value}`);
      } else if (!emitted.has(id)) {
        content[group].push({ name, value });
        emitted.add(id);
      }
    }
    // Preserve repeated headings and their ordering; duplicates can delimit
    // different sections and must not be erased independently from the blocks.
    content.notes = notes;
    const parsed = CatalogContentSchema.safeParse(content);
    if (!parsed.success) return { warnings: [...warnings, 'content-limit'] };
    if (!content.specifications.length && !content.packaging.length && !content.notes.length)
      return { warnings: [...warnings] };
    const blocks = CatalogNoteBlocksSchema.safeParse(noteBlocks);
    if (!blocks.success) return { warnings: [...warnings, 'content-limit'] };
    return { content: parsed.data, noteBlocks: blocks.data, warnings: [...warnings] };
  } catch {
    return { warnings: ['invalid-content'] };
  }
}
