import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const notice = (() => {
  const frontmatter = read('./content/privacy/en-US.md').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'privacy content has YAML frontmatter');
  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  return document.toJS() as {
    updated: string;
    heading: string;
    intro: string;
    sections: Array<{ heading: string; items: Array<{ title: string; body: string }> }>;
  };
})();
const statement = (title: string) =>
  notice.sections.flatMap((section) => section.items).find((item) => item.title === title)?.body ??
  '';

test('the privacy notice is reachable, quietly, from every place that collects details', () => {
  assert.match(read('../pages/privacy.astro'), /getPrivacyContent\(/);
  assert.match(read('./content/en-US.md'), /privacy: \{ label: Privacy, href: '\/privacy\/' \}/);
  assert.match(read('../components/SiteFooter.astro'), /href=\{footer\.privacy\.href\}/);
  assert.match(read('../components/ProjectForm.astro'), /href="\/privacy\/"/);
  for (const chat of [
    '../islands/ai/assistant/AssistantExperience.tsx',
    '../islands/ai/assistant/InquiryCard.tsx',
    '../islands/ai/AssistantWidget.tsx',
  ]) {
    // A new tab, so reading the notice never takes the visitor out of the conversation.
    assert.match(read(chat), /href="\/privacy\/" target="_blank" rel="noopener noreferrer"/, chat);
  }
});

test('each statement in the notice is still true of the code', () => {
  assert.ok(notice.updated.trim() && notice.intro.includes('Diversity Technology Limited'));

  // Passwords: "stored only as a one-way hash".
  assert.match(statement('Accounts'), /one-way hash/);
  assert.match(read('../../../../packages/auth/src/password.ts'), /argon2/);

  // Abuse limits keep "a keyed hash of your IP address, not the address itself".
  assert.match(statement('Technical records'), /keyed hash of your IP address/);
  assert.match(
    read('../../../../apps/ai-bff/src/server.ts'),
    /createHmac\('sha256', config\.ipHashSecret\)\.update\(sourceIp\)/,
  );

  // Contact details are removed before the model sees the conversation.
  assert.match(
    statement('AI model provider'),
    /Email addresses and phone numbers you\s+type are removed/,
  );
  const policy = read('../../../../packages/ai-policy/src/index.ts');
  assert.match(policy, /contactDataToModel: false/);
  assert.match(policy, /text: redactContactData\(turn\.text\)/);

  // The assistant keeps its conversation key in this tab only.
  assert.match(statement('Assistant'), /in\s+this tab only/);
  const persistence = read('../islands/ai/assistant/persistence.ts');
  assert.match(persistence, /globalThis\.sessionStorage/);
  assert.doesNotMatch(persistence, /localStorage/);

  // "We do not use advertising or analytics cookies."
  assert.match(statement('No tracking'), /do not use advertising or analytics cookies/);
  const layout = read('../layouts/BaseLayout.astro');
  for (const tracker of ['googletagmanager', 'gtag(', 'hm.baidu.com', 'clarity.ms', 'umami']) {
    assert.ok(!layout.includes(tracker), tracker);
  }

  // Chatting alone sends nothing to sales; only a confirmed inquiry does.
  assert.match(statement('AI assistant'), /only an\s+inquiry you review and confirm does/);
  assert.match(
    read('../islands/ai/assistant/InquiryCard.tsx'),
    /chatting alone does not create an inquiry/,
  );
});
