/**
 * Overstock storefront UI strings.
 *
 * Static interface copy only (from markdown). Product data comes from the
 * serverless API (`/api/overstock`). Add a locale by dropping in
 * `content/overstock/<locale>.md`.
 */
import type { CatalogListStrings, InquiryStrings } from '../islands/shop/types.ts';
import type { ShopNavItem } from './headphones.ts';

export interface OverstockContent {
  meta: { title: string; description: string };
  shopNav: ShopNavItem[];
  list: CatalogListStrings & {
    eyebrow: string;
    heading: string;
    subheading: string;
  };
  detail: {
    backLabel: string;
    codeLabel: string;
    categoryLabel: string;
    moqLabel: string;
    unitPriceLabel: string;
    clearanceLabel: string;
    savingsLabel: string;
    inventoryLabel: string;
    vipLabel: string;
    vipLockedLabel: string;
    statusAvailable: string;
    statusLow: string;
    statusSoldOut: string;
    addToInquiry: string;
    inInquiry: string;
    inquiryCta: string;
    soldOutNote: string;
    zoomHint: string;
    notFound: string;
  };
  inquiry: InquiryStrings;
}

interface MarkdownModule {
  frontmatter: OverstockContent;
}

const modules = import.meta.glob<MarkdownModule>('./content/overstock/*.md', { eager: true });

const BY_LOCALE = new Map<string, OverstockContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) BY_LOCALE.set(locale, mod.frontmatter);
}

export const DEFAULT_LOCALE = 'en-US';

export function getOverstockContent(locale: string = DEFAULT_LOCALE): OverstockContent {
  const content = BY_LOCALE.get(locale) ?? BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No overstock content for locale "${locale}" or default.`);
  }
  return content;
}
