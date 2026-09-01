import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normalizeDescription, sanitizeSourceHtml, sourceHtmlToText } from './descriptions.ts';

// --- placeholder detection --------------------------------------------------

test('treats the documented placeholder markup as a missing description', () => {
  for (const raw of ['1', '<p>1</p>', '<br>', '<br/>', '<br />', '<p></p>', '<p><br></p>', '']) {
    const result = normalizeDescription(raw);
    assert.equal(result.placeholder, true, `expected placeholder for ${JSON.stringify(raw)}`);
    assert.equal(result.html, undefined);
    assert.equal(result.text, undefined);
  }
});

test('treats whitespace-only and entity-only markup as missing', () => {
  for (const raw of ['   ', '<p>&nbsp;</p>', '<div> <span></span> </div>', '<p>　</p>']) {
    assert.equal(normalizeDescription(raw).placeholder, true, JSON.stringify(raw));
  }
});

test('treats common "no content" sentinels as missing', () => {
  for (const raw of ['-', 'N/A', 'n/a', 'null', 'undefined', '无', '暂无', '.']) {
    assert.equal(normalizeDescription(raw).placeholder, true, JSON.stringify(raw));
  }
});

test('keeps a real description and reports it as present', () => {
  const result = normalizeDescription('<p>Bluetooth 5.3 earbuds</p>');
  assert.equal(result.placeholder, false);
  assert.equal(result.html, '<p>Bluetooth 5.3 earbuds</p>');
  assert.equal(result.text, 'Bluetooth 5.3 earbuds');
});

test('a description whose only real content is a digit is still content', () => {
  // "1" alone is the known Dianxiaomi placeholder; "12 month warranty" is not.
  assert.equal(normalizeDescription('<p>12 month warranty</p>').placeholder, false);
});

test('refuses non-string input rather than coercing it', () => {
  assert.equal(normalizeDescription(undefined).placeholder, true);
  assert.equal(normalizeDescription(null).placeholder, true);
  assert.equal(normalizeDescription(42 as unknown as string).placeholder, true);
});

// --- sanitization -----------------------------------------------------------

test('drops script and style elements together with their contents', () => {
  assert.equal(sanitizeSourceHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
  assert.equal(sanitizeSourceHtml('<style>p{}</style><p>a</p>'), '<p>a</p>');
  assert.equal(sanitizeSourceHtml('<p>a</p><iframe src="x"></iframe>'), '<p>a</p>');
});

test('drops a raw-text element even when its close tag is missing', () => {
  assert.equal(sanitizeSourceHtml('<p>a</p><script>alert(1)'), '<p>a</p>');
});

test('is not fooled by a padded or differently-cased script tag', () => {
  assert.equal(sanitizeSourceHtml('<SCRIPT >alert(1)</SCRIPT>'), '');
  assert.equal(sanitizeSourceHtml('<script\ttype="x">alert(1)</script>'), '');
});

test('emits only allowlisted tags, whatever the input does', () => {
  // The property that matters is not what a specific mangled input produces,
  // but that nothing outside the allowlist can ever reach the output. The
  // sanitizer re-emits tags from its own table rather than editing the input,
  // so a smuggled `<scr<script>` cannot be reassembled downstream.
  const hostile = [
    '<scr<script>ipt>alert(1)</script>',
    '<<script>script>alert(1)<</script>/script>',
    '<img src=x onerror=alert(1)>',
    '<svg><animate onbegin=alert(1)>',
    '<p><![CDATA[<script>alert(1)</script>]]></p>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">',
    '<p onmouseover=alert(1)>x</p>',
  ];
  const allowed = new Set([
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'blockquote',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
  ]);
  for (const raw of hostile) {
    const out = sanitizeSourceHtml(raw);
    assert.ok(!/<\s*script/i.test(out), `script survived in ${JSON.stringify(raw)} -> ${out}`);
    for (const match of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
      const name = match[1] ?? '';
      assert.ok(allowed.has(name.toLowerCase()), `tag <${name}> escaped the allowlist: ${out}`);
    }
    // No attribute can survive: every emitted tag is `<name>` or `<name />`.
    assert.ok(!/<[a-zA-Z][^>]*\s[a-zA-Z-]+\s*=/.test(out), `attribute survived: ${out}`);
  }
});

test('strips every attribute, including event handlers and style', () => {
  assert.equal(sanitizeSourceHtml('<p onclick="steal()" style="x" class="y">hi</p>'), '<p>hi</p>');
  assert.equal(sanitizeSourceHtml('<img src="http://x/y.png" onerror="steal()">'), '');
});

test('unwraps unknown elements but keeps their text', () => {
  assert.equal(sanitizeSourceHtml('<font color="red">red</font>'), 'red');
  assert.equal(sanitizeSourceHtml('<custom-el>text</custom-el>'), 'text');
});

test('keeps the allowed formatting subset', () => {
  assert.equal(
    sanitizeSourceHtml('<p>a<br>b</p><ul><li><strong>c</strong></li></ul>'),
    '<p>a<br />b</p><ul><li><strong>c</strong></li></ul>',
  );
});

test('escapes stray angle brackets and ampersands in text', () => {
  assert.equal(sanitizeSourceHtml('5 < 6 & 7 > 6'), '5 &lt; 6 &amp; 7 &gt; 6');
});

test('preserves already-encoded entities without double-encoding them', () => {
  assert.equal(sanitizeSourceHtml('<p>a&amp;b &#39;c&#39;</p>'), '<p>a&amp;b &#39;c&#39;</p>');
});

test('drops comments, doctypes and processing instructions', () => {
  assert.equal(sanitizeSourceHtml('<!-- <script>x</script> --><p>a</p>'), '<p>a</p>');
  assert.equal(sanitizeSourceHtml('<!DOCTYPE html><p>a</p>'), '<p>a</p>');
});

test('drops links entirely rather than trusting a source href', () => {
  // A supplier-controlled href on an admin page is an off-site pivot for no
  // catalog benefit; the text survives, the destination does not.
  assert.equal(sanitizeSourceHtml('<a href="javascript:alert(1)">click</a>'), 'click');
  assert.equal(sanitizeSourceHtml('<a href="https://ok.example">click</a>'), 'click');
});

// --- plain text -------------------------------------------------------------

test('renders block structure as line breaks in the text projection', () => {
  assert.equal(sourceHtmlToText('<p>a</p><p>b</p>'), 'a\nb');
  assert.equal(sourceHtmlToText('a<br>b'), 'a\nb');
  assert.equal(sourceHtmlToText('<ul><li>a</li><li>b</li></ul>'), 'a\nb');
});

test('decodes entities in the text projection', () => {
  assert.equal(
    sourceHtmlToText('<p>a&amp;b&nbsp;c &#39;d&#39; &#x27;e&#x27;</p>'),
    "a&b c 'd' 'e'",
  );
});

test('collapses runaway whitespace in the text projection', () => {
  assert.equal(sourceHtmlToText('<p>a     b</p>\n\n\n<p>c</p>'), 'a b\nc');
});
