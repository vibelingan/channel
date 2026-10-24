import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CatalogTaxonomy, ProductFamily } from '@vibelingan-channel/shared';
import ts from 'typescript';
import { type PublicCatalogTaxonomy, parseTaxonomyCatalogQuery } from './catalog-taxonomy.ts';
import {
  type NumberedCatalogQuery,
  type NumberedCatalogState,
  cancelNumberedPage,
  catalogQueryEquals,
  catalogQueryWithFilters,
  catalogUrl,
  initialNumberedCatalogState,
  parseCatalogQuery,
} from './numbered-catalog-state.ts';

function executableDeclarations(sourceUrl: URL, names: string[]): string {
  const source = ts.createSourceFile(
    sourceUrl.pathname,
    readFileSync(sourceUrl, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      declarations.set(node.name.text, node.getText(source));
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.includes(node.name.text)
    ) {
      declarations.set(node.name.text, `const ${node.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) assert.ok(declarations.has(name), `Missing production handler ${name}`);
  return names.map((name) => declarations.get(name)).join('\n');
}

function bindHandlers<Handlers>(
  sourceUrl: URL,
  names: string[],
  bindings: Record<string, unknown>,
): Handlers {
  const source = `const { ${Object.keys(bindings).join(', ')} } = bindings;
    ${executableDeclarations(sourceUrl, names)}
    return { ${names.join(', ')} };`;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function('bindings', outputText)(bindings) as Handlers;
}

function filterHarness(
  options: {
    keys?: string[];
    invalid?: boolean;
    requested?: NumberedCatalogQuery;
    includeClear?: boolean;
  } = {},
) {
  const categoryKeys = options.keys ?? ['alpha', 'beta'];
  const stateRef = { current: initialNumberedCatalogState() };
  if (options.requested) stateRef.current = { ...stateRef.current, requested: options.requested };
  if (options.invalid) stateRef.current = { ...stateRef.current, error: 'Invalid selection' };
  const invalidSelectionRef = { current: options.invalid ?? false };
  const requests: NumberedCatalogQuery[] = [];
  let selected: string[] = [];
  let search = '';
  const location = new URL('https://catalog.example/headphones/?subcategoryIds=retired&page=8');
  const historyWrites: string[] = [];
  const history = {
    state: null,
    pushState: (_state: unknown, _title: string, next: string) => historyWrites.push(next),
    replaceState: (_state: unknown, _title: string, next: string) => historyWrites.push(next),
  };
  const names = [
    'handleFilters',
    'writeCatalogHistory',
    ...(options.includeClear ? ['handleClearFilters'] : []),
  ];
  const handlers = bindHandlers<{
    handleFilters: (search: string, categories: string[], categoriesChanged?: boolean) => void;
    handleClearFilters: () => void;
  }>(new URL('./CatalogFamilyPage.tsx', import.meta.url), names, {
    categoryKeys,
    stateRef,
    invalidSelectionRef,
    detailIsOpen: () => false,
    window: { location, history },
    setSearchInput: (next: string) => {
      search = next;
    },
    setSelectedCategories: (next: string[]) => {
      selected = next;
    },
    catalogQueryEquals,
    catalogQueryWithFilters,
    catalogUrl,
    navigate: (query: NumberedCatalogQuery) => {
      requests.push(query);
    },
  });
  return {
    ...handlers,
    requests,
    historyWrites,
    invalidSelectionRef,
    inputs: () => ({ selected, search }),
  };
}

test('reselecting all categories restores the unfiltered query, including orphan products', () => {
  const harness = filterHarness({ requested: { page: 3, search: '', categories: ['alpha'] } });
  harness.handleFilters('  speaker  ', ['beta', 'alpha', 'alpha'], true);
  assert.deepEqual(harness.requests, [{ page: 1, search: 'speaker', categories: null }]);
});

test('explicit empty selection remains empty even with zero registered categories', () => {
  for (const keys of [['alpha', 'beta'], []]) {
    const harness = filterHarness({ keys });
    harness.handleFilters('', [], true);
    assert.deepEqual(harness.requests, [{ page: 1, search: '', categories: [] }]);
  }
});

test('search alone preserves null when the registry has no active categories', () => {
  const harness = filterHarness({ keys: [] });
  harness.handleFilters('speaker', []);
  assert.deepEqual(harness.requests, [{ page: 1, search: 'speaker', categories: null }]);
});

test('an explicit valid selection recovers an invalid URL, but search alone stays closed', () => {
  const harness = filterHarness({
    invalid: true,
    requested: { page: 1, search: '', categories: [] },
  });
  harness.handleFilters('search', []);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.invalidSelectionRef.current, true);
  harness.handleFilters('', ['unknown'], true);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.invalidSelectionRef.current, true);
  harness.handleFilters('', ['alpha'], true);
  assert.deepEqual(harness.requests, [{ page: 1, search: '', categories: ['alpha'] }]);
  assert.equal(harness.invalidSelectionRef.current, false);
  assert.deepEqual(harness.historyWrites, ['/headphones/?page=1&category=alpha']);
});

test('clear filters recovers an invalid URL with no active checkboxes', () => {
  const harness = filterHarness({ keys: [], invalid: true, includeClear: true });
  harness.handleClearFilters();
  assert.equal(harness.invalidSelectionRef.current, false);
  assert.deepEqual(harness.requests, [{ page: 1, search: '', categories: null }]);
  assert.deepEqual(harness.inputs(), { selected: [], search: '' });
  assert.deepEqual(harness.historyWrites, ['/headphones/?page=1']);
});

test('automatic invalid URL reads abort pending products without requesting an unfiltered list', () => {
  const registry: PublicCatalogTaxonomy = {
    family: 'headphones',
    name: 'Headphones',
    revision: 1,
    children: [],
  };
  for (const taxonomyPending of [true, false]) {
    const stateRef = { current: initialNumberedCatalogState() };
    const invalidSelectionRef = { current: false };
    const abortRef = { current: new AbortController() };
    let requests = 0;
    let selected: string[] = ['retired'];
    const { readLocation } = bindHandlers<{ readLocation: () => void }>(
      new URL('./CatalogFamilyPage.tsx', import.meta.url),
      ['readLocation'],
      {
        useCallback: (callback: () => void) => callback,
        window: { location: { search: '?category=retired' } },
        registry,
        stateRef,
        invalidSelectionRef,
        abortRef,
        taxonomyPending,
        content: { list: { errorLabel: 'Catalog failed' } },
        parseTaxonomyCatalogQuery,
        parseCatalogQuery,
        cancelNumberedPage,
        commit: (next: NumberedCatalogState) => {
          stateRef.current = next;
        },
        setSelectedCategories: (next: string[]) => {
          selected = next;
        },
        navigate: () => {
          requests += 1;
        },
        restoreInputs: () => {
          throw new Error('Invalid URL must not restore inputs');
        },
      },
    );
    readLocation();
    assert.equal(requests, 0);
    assert.equal(invalidSelectionRef.current, true);
    assert.equal(abortRef.current.signal.aborted, true);
    assert.deepEqual(selected, []);
    assert.equal(stateRef.current.pending, taxonomyPending);
    assert.equal(stateRef.current.error === null, taxonomyPending);
    assert.deepEqual(stateRef.current.products, []);
  }
});

function taxonomy(
  family: ProductFamily,
  overrides: Partial<CatalogTaxonomy> = {},
): CatalogTaxonomy {
  return { family, name: family, revision: 1, children: [], ...overrides };
}

function reloadHarness() {
  let complete: (value: { isSuccess: boolean }) => void = () => {
    throw new Error('Not started');
  };
  const response = new Promise<{ isSuccess: boolean }>((resolve) => {
    complete = resolve;
  });
  const state: { family: ProductFamily; draft: CatalogTaxonomy | null; message: string } = {
    family: 'headphones',
    draft: null,
    message: '',
  };
  const mounted = { current: true };
  const handlers = bindHandlers<{
    reset: (family: ProductFamily) => void;
    edit: (draft: CatalogTaxonomy) => void;
    reload: () => Promise<void>;
  }>(new URL('../admin/CatalogTaxonomyManager.tsx', import.meta.url), ['reset', 'edit', 'reload'], {
    family: 'headphones',
    mounted,
    inFlight: { current: false },
    editGenerationRef: { current: 0 },
    query: { refetch: () => response },
    setDraft: (next: CatalogTaxonomy | null) => {
      state.draft = next;
    },
    setFamily: (next: ProductFamily) => {
      state.family = next;
    },
    setMessage: (next: string) => {
      state.message = next;
    },
    setConfirming: () => {},
    setDiscardTarget: () => {},
    setNeedsReload: () => {},
  });
  return { ...handlers, state, mounted, complete };
}

test('a deferred family A reload cannot discard a newer family B draft', async () => {
  const handlers = reloadHarness();
  const pending = handlers.reload();
  handlers.reset('toys');
  const draft = taxonomy('toys', { name: 'Unsaved toys' });
  handlers.edit(draft);
  handlers.complete({ isSuccess: true });
  await pending;
  assert.equal(handlers.state.family, 'toys');
  assert.equal(handlers.state.draft, draft);
});

test('same-family edits and an A to B to A switch invalidate an older reload', async () => {
  for (const switchFamily of [false, true]) {
    const handlers = reloadHarness();
    const pending = handlers.reload();
    if (switchFamily) {
      handlers.reset('toys');
      handlers.reset('headphones');
    }
    const draft = taxonomy('headphones', { name: 'New draft' });
    handlers.edit(draft);
    handlers.complete({ isSuccess: true });
    await pending;
    assert.equal(handlers.state.draft, draft);
  }
});

test('reload discards the original draft only on mounted, unchanged, successful completion', async () => {
  for (const [success, mounted] of [
    [true, true],
    [false, true],
    [true, false],
  ]) {
    const handlers = reloadHarness();
    const draft = taxonomy('headphones', { name: 'Old draft' });
    handlers.edit(draft);
    const pending = handlers.reload();
    handlers.mounted.current = Boolean(mounted);
    handlers.complete({ isSuccess: Boolean(success) });
    await pending;
    assert.equal(handlers.state.draft, success && mounted ? null : draft);
  }
});
