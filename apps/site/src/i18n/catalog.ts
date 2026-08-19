import type { ProductFamily } from '@vibelingan-channel/shared';

export interface CatalogCategoryContent {
  key: string;
  label: string;
}

export interface CatalogFamilyContent {
  key: ProductFamily;
  label: string;
  href: string;
  eyebrow: string;
  heading: string;
  description: string;
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  categories: readonly CatalogCategoryContent[];
}

export interface CatalogContent {
  locale: string;
  menu: { label: string; allLabel: string };
  hub: {
    eyebrow: string;
    heading: string;
    body: string;
    seoTitle: string;
    seoDescription: string;
    quoteLabel: string;
    catalogLabel: string;
    browseLabel: string;
    featuredHeading: string;
    emptyLabel: string;
  };
  list: {
    filterLabel: string;
    allLabel: string;
    resultsLabel: string;
    searchPlaceholder: string;
    loadingLabel: string;
    errorLabel: string;
    retryLabel: string;
    emptyLabel: string;
    loadMoreLabel: string;
    wholesaleLabel: string;
    moqLabel: string;
    viewDetail: string;
  };
  detail: {
    backLabel: string;
    moqLabel: string;
    unitPriceLabel: string;
    wholesaleLabel: string;
    inquiryCta: string;
    relatedHeading: string;
    notFound: string;
  };
  families: readonly CatalogFamilyContent[];
}

interface MarkdownModule {
  frontmatter: CatalogContent;
}

const modules = import.meta.glob<MarkdownModule>('./content/catalog/*.md', { eager: true });
const byLocale = new Map<string, CatalogContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) byLocale.set(locale, mod.frontmatter);
}

export const DEFAULT_CATALOG_LOCALE = 'en-US';

export function getCatalogContent(locale = DEFAULT_CATALOG_LOCALE): CatalogContent {
  const content = byLocale.get(locale) ?? byLocale.get(DEFAULT_CATALOG_LOCALE);
  if (!content) throw new Error(`No catalog content for locale "${locale}" or default.`);
  return content;
}

export function getCatalogFamily(
  productFamily: ProductFamily,
  locale = DEFAULT_CATALOG_LOCALE,
): CatalogFamilyContent {
  const family = getCatalogContent(locale).families.find(
    (candidate) => candidate.key === productFamily,
  );
  if (!family) throw new Error(`No catalog content for product family "${productFamily}".`);
  return family;
}
