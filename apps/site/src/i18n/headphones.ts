/**
 * Headphones storefront UI strings.
 *
 * Only static interface copy lives here (loaded from markdown). Product data
 * itself comes from the serverless API (`/api/products`), not this file.
 * Add a locale by dropping in `content/headphones/<locale>.md`.
 */

export interface ShopNavItem {
  label: string;
  href: string;
  emphasis?: boolean;
}

export interface CategoryOption {
  key: string;
  label: string;
}

export interface HeadphonesContent {
  meta: { title: string; description: string };
  shopNav: ShopNavItem[];
  list: {
    eyebrow: string;
    heading: string;
    subheading: string;
    filterLabel: string;
    allLabel: string;
    resultsLabel: string;
    emptyLabel: string;
    categories: CategoryOption[];
    wholesaleLabel: string;
    vipLabel: string;
    vipLockedLabel: string;
    viewDetail: string;
    moqLabel: string;
  };
  detail: {
    backLabel: string;
    seriesLabel: string;
    modelLabel: string;
    typeLabel: string;
    moqLabel: string;
    unitPriceLabel: string;
    wholesaleLabel: string;
    vipLabel: string;
    vipLockedLabel: string;
    inquiryCta: string;
    zoomHint: string;
    notFound: string;
  };
  inquiry: {
    title: string;
    intro: string;
    emailLabel: string;
    companyLabel: string;
    countryLabel: string;
    downloadCatalog: string;
    requestQuote: string;
    submitLabel: string;
    cancelLabel: string;
    successTitle: string;
    successBody: string;
    disclaimer: string;
  };
}

interface MarkdownModule {
  frontmatter: HeadphonesContent;
}

const modules = import.meta.glob<MarkdownModule>('./content/headphones/*.md', { eager: true });

const BY_LOCALE = new Map<string, HeadphonesContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) BY_LOCALE.set(locale, mod.frontmatter);
}

export const DEFAULT_LOCALE = 'en-US';

export function getHeadphonesContent(locale: string = DEFAULT_LOCALE): HeadphonesContent {
  const content = BY_LOCALE.get(locale) ?? BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No headphones content for locale "${locale}" or default.`);
  }
  return content;
}
