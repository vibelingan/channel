import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogPreparationControls } from './CatalogPreparationControls.tsx';

test('recovery controls are SSR safe and do not start or read a task on render', () => {
  const stored = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw Error('SSR must not read browser storage');
    },
  });
  try {
    const html = renderToStaticMarkup(
      createElement(CatalogPreparationControls, {
        productId: 'clock',
        onEdit: () => {
          throw Error('render must not edit');
        },
        onReady: () => {
          throw Error('render must not recheck');
        },
      }),
    );
    assert.match(html, /Checking session/);
    assert.doesNotMatch(html, /token|signature|nonce|Save and publish/);
  } finally {
    if (stored) Object.defineProperty(globalThis, 'sessionStorage', stored);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
