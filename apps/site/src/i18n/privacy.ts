/**
 * Privacy notice copy. Add a locale by dropping in `content/privacy/<locale>.md`.
 * Each statement must stay true of the running site and assistant.
 */

export interface PrivacyContent {
  locale: string;
  updated: string;
  heading: string;
  intro: string;
  sections: Array<{
    heading: string;
    items: Array<{ title: string; body: string }>;
  }>;
}

interface MarkdownModule {
  frontmatter: PrivacyContent;
}

const modules = import.meta.glob<MarkdownModule>('./content/privacy/*.md', { eager: true });

const BY_LOCALE = new Map<string, PrivacyContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) BY_LOCALE.set(locale, mod.frontmatter);
}

export const DEFAULT_LOCALE = 'en-US';

export function getPrivacyContent(locale: string = DEFAULT_LOCALE): PrivacyContent {
  const content = BY_LOCALE.get(locale) ?? BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No privacy content for locale "${locale}" or default.`);
  }
  return content;
}
