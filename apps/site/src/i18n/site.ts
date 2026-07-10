/**
 * i18n site-content loader.
 *
 * Each locale is a single markdown file under `content/<locale>.md` whose
 * frontmatter holds all the structured strings for the site. Adding a new
 * region/language is purely additive: drop in a new markdown file and it is
 * picked up automatically — no code changes required.
 */

export interface NavItem {
  label: string;
  href: string;
  emphasis?: boolean;
}

export interface CtaLink {
  label: string;
  href: string;
}

export interface ContentSection {
  id: string;
  eyebrow: string;
  heading: string;
  body: string;
  image: string;
  imageAlt: string;
}

export interface FooterColumn {
  heading: string;
  links: CtaLink[];
}

export interface IconCard {
  title: string;
  description: string;
  icon: string;
}

export interface StatItem {
  value: string;
  label: string;
}

export interface ProductTeaserItem {
  name: string;
  tagline: string;
  msrp: string;
}

export interface SiteContent {
  locale: string;
  label: string;
  dir: 'ltr' | 'rtl';
  brand: {
    name: string;
    /** Optional logo image path (e.g. an SVG wordmark). Falls back to initials. */
    logo?: string;
    logoInitials: string;
    minOrder: string;
    tagline: string;
  };
  nav: { items: NavItem[] };
  hero: {
    eyebrow: string;
    heading: string;
    subheading: string;
    primaryCta: CtaLink;
    secondaryCta: CtaLink;
    scrollLabel: string;
  };
  aiShowcase: {
    eyebrow: string;
    heading: string;
    cards: IconCard[];
  };
  services: {
    eyebrow: string;
    heading: string;
    intro: string;
    items: IconCard[];
  };
  teardownTeaser: {
    eyebrow: string;
    heading: string;
    description: string;
    stats: StatItem[];
    cta: CtaLink;
  };
  blueOceanTeaser: {
    eyebrow: string;
    heading: string;
    description: string;
    products: ProductTeaserItem[];
    cta: CtaLink;
  };
  factorySection: {
    eyebrow: string;
    heading: string;
    body: string;
    stats: StatItem[];
  };
  ctaSection: {
    heading: string;
    description: string;
    primaryCta: CtaLink;
    secondaryCta: CtaLink;
  };
  /** Legacy sections (kept for backward compat — not used on new homepage) */
  sections?: ContentSection[];
  footer: {
    blurb: string;
    columns: FooterColumn[];
    legal: string;
  };
}

interface MarkdownModule {
  frontmatter: SiteContent;
}

// Eagerly load every locale markdown file's frontmatter at build time.
const modules = import.meta.glob<MarkdownModule>('./content/*.md', { eager: true });

const CONTENT_BY_LOCALE = new Map<string, SiteContent>();
for (const mod of Object.values(modules)) {
  const content = mod.frontmatter;
  if (content?.locale) {
    CONTENT_BY_LOCALE.set(content.locale, content);
  }
}

export const DEFAULT_LOCALE = 'en-US';

export function availableLocales(): string[] {
  return [...CONTENT_BY_LOCALE.keys()];
}

/** Resolve site content for a locale, falling back to the default locale. */
export function getSiteContent(locale: string = DEFAULT_LOCALE): SiteContent {
  const content = CONTENT_BY_LOCALE.get(locale) ?? CONTENT_BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No site content found for locale "${locale}" or default "${DEFAULT_LOCALE}".`);
  }
  return content;
}
