import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  isProductFamily,
} from '@vibelingan-channel/shared';
import ts from 'typescript';
import type { PublicCatalogTaxonomy } from '../islands/shop/catalog-taxonomy.ts';

class ListenerTarget extends EventTarget {
  readonly registrations = new Map<string, number>();

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) {
    this.registrations.set(type, (this.registrations.get(type) ?? 0) + 1);
    super.addEventListener(type, callback, options);
  }
}

class MenuLink {
  href = '';
  textContent = '';
  className = '';
}

class MenuGroup {
  readonly dataset: { taxonomyFamily: ProductFamily };
  readonly name = { textContent: '' };
  readonly error = { hidden: true };
  readonly retry = { hidden: true, disabled: false };
  readonly parent: { href: string };
  readonly children = {
    links: [] as MenuLink[],
    replaceChildren(...links: MenuLink[]) {
      this.links = links;
    },
  };

  constructor(family: ProductFamily) {
    this.dataset = { taxonomyFamily: family };
    this.parent = { href: `https://catalog.example/${family}/` };
  }

  querySelector(selector: string) {
    switch (selector) {
      case '[data-taxonomy-name]':
        return this.name;
      case '[data-taxonomy-retry]':
        return this.retry;
      case '[data-taxonomy-children]':
        return this.children;
      case 'a':
        return this.parent;
      default:
        throw new Error(`Unexpected selector: ${selector}`);
    }
  }

  querySelectorAll(selector: string) {
    assert.equal(selector, '[data-taxonomy-error], [data-taxonomy-retry]');
    return [this.error, this.retry];
  }
}

function registry(
  family: ProductFamily,
  overrides: Partial<PublicCatalogTaxonomy> = {},
): PublicCatalogTaxonomy {
  return {
    family,
    name: family,
    revision: 1,
    children: [{ id: `${family}-child`, name: 'Active child', slug: 'child', order: 0 }],
    ...overrides,
  };
}

function headerHarness() {
  const source = readFileSync(new URL('./SiteHeader.astro', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'Missing header script');
  const parsed = ts.createSourceFile('SiteHeader.ts', script, ts.ScriptTarget.Latest, true);
  const start = parsed.statements.findIndex(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'taxonomyRequests',
      ),
  );
  const end = parsed.statements.findIndex(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'focusForDesktop',
  );
  assert.ok(start >= 0 && end > start, 'Missing taxonomy lifecycle script boundaries');
  const executable = parsed.statements
    .slice(start, end)
    .map((statement) => statement.getText(parsed))
    .join('\n');
  const groups = PRODUCT_FAMILY_OPTIONS.flatMap((family) => [
    new MenuGroup(family),
    new MenuGroup(family),
  ]);
  const header = Object.assign(new ListenerTarget(), {
    querySelectorAll(selector: string) {
      if (selector === '[data-taxonomy-family]') return groups;
      const family = selector.match(/^\[data-taxonomy-family="([^"]+)"\]$/)?.[1];
      assert.ok(family, `Unexpected header selector: ${selector}`);
      return groups.filter((group) => group.dataset.taxonomyFamily === family);
    },
  });
  const window = new ListenerTarget();
  const document = Object.assign(new ListenerTarget(), {
    createElement(tag: string) {
      assert.equal(tag, 'a');
      return new MenuLink();
    },
  });
  const requests: {
    family: ProductFamily;
    signal: AbortSignal;
    resolve: (value: PublicCatalogTaxonomy) => void;
    reject: (error: Error) => void;
  }[] = [];
  const { outputText } = ts.transpileModule(executable, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  runInNewContext(outputText, {
    header,
    window,
    document,
    AbortController,
    URL,
    isProductFamily,
    Element: MenuLink,
    scheduleHeaderFit: () => {},
    fetchCatalogTaxonomy: (family: ProductFamily, signal: AbortSignal) =>
      new Promise<PublicCatalogTaxonomy>((resolve, reject) => {
        requests.push({ family, signal, resolve, reject });
      }),
  });
  function show(persisted: boolean) {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: persisted });
    window.dispatchEvent(event);
  }
  return { header, window, document, groups, requests, show };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('BFCache restore restarts aborted menus with fresh signals and rejects stale responses', async () => {
  const harness = headerHarness();
  const count = PRODUCT_FAMILY_OPTIONS.length;
  assert.equal(harness.requests.length, count);
  harness.show(false);
  assert.equal(
    harness.requests.length,
    count,
    'Ordinary pageshow must not duplicate initial loads',
  );
  const first = harness.requests.slice();
  harness.window.dispatchEvent(new Event('pagehide'));
  assert.ok(first.every((request) => request.signal.aborted));
  harness.show(true);
  assert.equal(harness.requests.length, count * 2);
  const restored = harness.requests.slice(count);
  for (const request of restored) {
    assert.equal(request.signal.aborted, false);
    request.resolve(registry(request.family, { name: 'Restored registry' }));
  }
  await settle();
  for (const request of first)
    request.resolve(registry(request.family, { name: 'Stale registry' }));
  await settle();
  for (const group of harness.groups) {
    assert.equal(group.name.textContent, 'Restored registry');
    assert.equal(group.children.links.length, 1);
    assert.equal(group.error.hidden, true);
    const link = group.children.links[0];
    assert.ok(link);
    assert.equal(
      link.href,
      `/${group.dataset.taxonomyFamily}/?category=${group.dataset.taxonomyFamily}-child&page=1`,
    );
  }
});

test('repeated BFCache cycles replace children and retain one retry listener', async () => {
  const harness = headerHarness();
  const count = PRODUCT_FAMILY_OPTIONS.length;
  for (const request of harness.requests) request.resolve(registry(request.family));
  await settle();
  for (let cycle = 1; cycle <= 2; cycle++) {
    harness.window.dispatchEvent(new Event('pagehide'));
    harness.show(true);
    assert.equal(harness.requests.length, count * (cycle + 1));
    for (const request of harness.requests.slice(count * cycle)) {
      assert.equal(request.signal.aborted, false);
      request.resolve(registry(request.family));
    }
    await settle();
    assert.ok(harness.groups.every((group) => group.children.links.length === 1));
  }
  assert.equal(harness.header.registrations.get('click'), 1);
  assert.equal(harness.window.registrations.get('pagehide'), 1);
  assert.equal(harness.window.registrations.get('pageshow'), 1);
  harness.document.dispatchEvent(new Event('astro:before-swap'));
  assert.ok(harness.requests.every((request) => request.signal.aborted));
});

test('a failed restored menu exposes retry without keeping obsolete child links', async () => {
  const harness = headerHarness();
  for (const request of harness.requests) request.resolve(registry(request.family));
  await settle();
  const count = harness.requests.length;
  harness.window.dispatchEvent(new Event('pagehide'));
  harness.show(true);
  assert.equal(harness.requests.length, count * 2);
  for (const request of harness.requests.slice(count)) request.reject(new Error('Unavailable'));
  await settle();
  for (const group of harness.groups) {
    assert.equal(group.children.links.length, 0);
    assert.equal(group.error.hidden, false);
    assert.equal(group.retry.hidden, false);
    assert.equal(group.retry.disabled, false);
  }
});
