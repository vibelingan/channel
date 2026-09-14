/**
 * OEM Development page content loader.
 *
 * Mirrors the site-content pattern: one markdown file per locale under
 * `content/oem/<locale>.md`, all structured strings living in frontmatter.
 * Add a new locale by dropping in another markdown file — no code changes.
 */

export interface IconCard {
  icon: string;
  title: string;
  desc?: string;
}

export interface WorkflowStep {
  label: string;
  desc?: string;
}

export interface ProcessStep {
  title: string;
  desc: string;
}

export interface Reason {
  icon: string;
  stat?: string;
  label: string;
  desc: string;
}

export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'number' | 'select' | 'file';
  required?: boolean;
  placeholder?: string;
  options?: string[];
  accept?: string;
  full?: boolean;
  /** Optional helper text shown beneath the field (e.g. file upload tips). */
  hint?: string;
}

export interface OemContent {
  meta: {
    title: string;
    description: string;
  };
  hero: {
    eyebrow: string;
    heading: string;
    subheading: string;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
  };
  capabilities: {
    id: string;
    eyebrow: string;
    heading: string;
    intro: string;
    items: IconCard[];
    note: string;
  };
  process: {
    id: string;
    eyebrow: string;
    heading: string;
    intro: string;
    steps: ProcessStep[];
  };
  whyUs: {
    id: string;
    eyebrow: string;
    heading: string;
    intro: string;
    reasons: Reason[];
  };
  submit: {
    id: string;
    eyebrow: string;
    heading: string;
    intro: string;
    fields: FormField[];
    submitLabel: string;
    disclaimer: string;
    successTitle: string;
    successBody: string;
  };
  /** Required OEM-specific factory video and poster. */
  factoryVideo: {
    src: string;
    poster: string;
    /** Intrinsic pixel dimensions of `poster`, to reserve layout space (avoid CLS). */
    posterWidth: number;
    posterHeight: number;
    caption?: string;
  };
}

interface MarkdownModule {
  frontmatter: OemContent & { locale?: string };
}

const modules = import.meta.glob<MarkdownModule>('./content/oem/*.md', { eager: true });

const BY_LOCALE = new Map<string, OemContent>();
for (const [path, mod] of Object.entries(modules)) {
  // Derive locale from the file name (e.g. ./content/oem/en-US.md -> en-US).
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) BY_LOCALE.set(locale, mod.frontmatter);
}

export const DEFAULT_LOCALE = 'en-US';

export function getOemContent(locale: string = DEFAULT_LOCALE): OemContent {
  const content = BY_LOCALE.get(locale) ?? BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No OEM content found for locale "${locale}" or default "${DEFAULT_LOCALE}".`);
  }
  return content;
}
