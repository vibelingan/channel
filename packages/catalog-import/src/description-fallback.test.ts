import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveDescription } from './description-fallback.ts';

const base = {
  title: 'Wireless Earbuds A1',
  attributes: {},
  specs: {},
};

// --- step 1: the merchant's own description ---------------------------------

test('a real description is used as written', () => {
  const resolved = resolveDescription({
    ...base,
    description: '<p>Noise cancelling earbuds with a charging case.</p>',
  });
  assert.equal(resolved.source, 'description');
  assert.equal(resolved.text, 'Noise cancelling earbuds with a charging case.');
  assert.equal(resolved.html, '<p>Noise cancelling earbuds with a charging case.</p>');
});

test('a real description wins even when a short description also exists', () => {
  const resolved = resolveDescription({
    ...base,
    description: '<p>Full description.</p>',
    shortDescription: '<p>Short one.</p>',
  });
  assert.equal(resolved.source, 'description');
  assert.equal(resolved.text, 'Full description.');
});

// --- step 2: the short description ------------------------------------------

test('a placeholder description falls through to the short description', () => {
  const resolved = resolveDescription({
    ...base,
    description: '<p>1</p>',
    shortDescription: '<p>Compact earbuds, 30h battery.</p>',
  });
  assert.equal(resolved.source, 'shortDescription');
  assert.equal(resolved.text, 'Compact earbuds, 30h battery.');
});

test('an empty description falls through to the short description', () => {
  const resolved = resolveDescription({ ...base, shortDescription: 'Compact earbuds.' });
  assert.equal(resolved.source, 'shortDescription');
});

// --- step 3: structured copy from supplied fields ---------------------------

test('two placeholders fall through to structured copy from supplied fields', () => {
  const resolved = resolveDescription({
    ...base,
    description: '<p>1</p>',
    shortDescription: '<br>',
    brand: 'Acme',
    attributes: { Material: 'ABS', 'Battery life': '30h' },
  });
  assert.equal(resolved.source, 'structured');
  assert.equal(
    resolved.text,
    ['Wireless Earbuds A1', '', 'Brand: Acme', 'Material: ABS', 'Battery life: 30h'].join('\n'),
  );
});

test('structured copy restates supplied fields and invents nothing', () => {
  const resolved = resolveDescription({
    ...base,
    description: '1',
    brand: 'Acme',
    attributes: { Material: 'ABS' },
  });
  // Every word in the output must come from the title, the field labels, or a
  // supplied value. No adjectives, no claims, no marketing language.
  const allowed = new Set(
    ['Wireless', 'Earbuds', 'A1', 'Brand:', 'Acme', 'Material:', 'ABS'].map((w) => w.toLowerCase()),
  );
  for (const word of resolved.text.split(/\s+/).filter(Boolean)) {
    assert.ok(allowed.has(word.toLowerCase()), `invented word in fallback copy: ${word}`);
  }
});

test('option values contribute to the structured copy', () => {
  const resolved = resolveDescription({
    ...base,
    description: '1',
    optionValues: { Colour: 'Black' },
  });
  assert.equal(resolved.source, 'structured');
  assert.ok(resolved.text.includes('Colour: Black'));
});

test('structured copy skips blank and unusable attribute values', () => {
  const resolved = resolveDescription({
    ...base,
    description: '1',
    brand: 'Acme',
    attributes: { Material: '', Empty: '   ', Good: 'yes' },
  });
  assert.ok(!resolved.text.includes('Material:'));
  assert.ok(!resolved.text.includes('Empty:'));
  assert.ok(resolved.text.includes('Good: yes'));
});

// --- step 4: title plus specification table ---------------------------------

test('with no brand or attributes, specs still produce a table', () => {
  const resolved = resolveDescription({
    ...base,
    description: '1',
    specs: { 'Weight (kg)': '0.35', 'Length (cm)': '12' },
  });
  assert.equal(resolved.source, 'titleAndSpecs');
  assert.equal(
    resolved.text,
    ['Wireless Earbuds A1', '', 'Weight (kg): 0.35', 'Length (cm): 12'].join('\n'),
  );
});

test('with nothing but a title, the title is the description', () => {
  const resolved = resolveDescription({ ...base, description: '1' });
  assert.equal(resolved.source, 'titleAndSpecs');
  assert.equal(resolved.text, 'Wireless Earbuds A1');
});

test('with no usable title either, nothing is produced', () => {
  const resolved = resolveDescription({
    title: '   ',
    attributes: {},
    specs: {},
    description: '1',
  });
  assert.equal(resolved.source, 'none');
  assert.equal(resolved.text, '');
  assert.equal(resolved.html, undefined);
});

// --- safety and shape -------------------------------------------------------

test('generated copy is emitted as escaped HTML, never as raw source markup', () => {
  const resolved = resolveDescription({
    title: 'Earbuds <script>alert(1)</script>',
    attributes: { 'A<b>': 'B&C' },
    specs: {},
    description: '1',
  });
  assert.equal(/<script/i.test(resolved.html ?? ''), false);
  assert.ok((resolved.html ?? '').includes('&lt;script&gt;'));
  assert.ok((resolved.html ?? '').includes('&amp;'));
});

test('unsafe markup in the merchant description is sanitized, not passed through', () => {
  const resolved = resolveDescription({
    ...base,
    description: '<p>Real copy</p><script>steal()</script>',
  });
  assert.equal(resolved.source, 'description');
  assert.equal(resolved.html, '<p>Real copy</p>');
  assert.equal(resolved.sanitized, true);
});

test('the same input always produces the same output', () => {
  const input = {
    ...base,
    description: '1',
    brand: 'Acme',
    attributes: { b: '2', a: '1' },
  };
  assert.equal(resolveDescription(input).text, resolveDescription(input).text);
});
