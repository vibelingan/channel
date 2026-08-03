/**
 * Headphones storefront UI strings.
 *
 * Static interface copy and reviewed hero-media provenance live here. Catalog
 * product data comes from the serverless API (`/api/products`). Add a locale
 * by dropping in `content/headphones/<locale>.md`.
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

export interface HeadphonesHeroSource {
  imageId: string;
  width: number;
  height: number;
  sha256: string;
}

export interface HeadphonesContent {
  meta: { title: string; description: string };
  shopNav: ShopNavItem[];
  hero: {
    eyebrow: string;
    heading: string;
    body: string;
    proof: readonly string[];
    primaryCta: string;
    secondaryCta: string;
    productId: string;
    productName: string;
    imageAlt: string;
    loadingLabel: string;
    unavailableLabel: string;
    sources: readonly [HeadphonesHeroSource, HeadphonesHeroSource, HeadphonesHeroSource];
  };
  list: {
    eyebrow: string;
    heading: string;
    subheading: string;
    filterLabel: string;
    allLabel: string;
    resultsLabel: string;
    loadingLabel: string;
    errorLabel: string;
    retryLabel: string;
    emptyLabel: string;
    emptyStateLabel: string;
    emptyCtaLabel: string;
    loadMoreLabel: string;
    loadingMoreLabel: string;
    resultProgressLabel: string;
    categories: CategoryOption[];
    wholesaleLabel: string;
    vipLabel: string;
    vipLockedLabel: string;
    viewDetail: string;
    moqLabel: string;
  };
  detail: {
    backLabel: string;
    backToModelsLabel: string;
    seriesLabel: string;
    modelLabel: string;
    typeLabel: string;
    moqLabel: string;
    unitPriceLabel: string;
    wholesaleLabel: string;
    vipLabel: string;
    vipLockedLabel: string;
    inquiryCta: string;
    oemInquiryCta: string;
    viewAllLabel: string;
    imageUnavailableLabel: string;
    zoomHint: string;
    notFound: string;
  };
  oemCta: {
    eyebrow: string;
    heading: string;
    body: string;
    primaryLabel: string;
    secondaryLabel: string;
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
