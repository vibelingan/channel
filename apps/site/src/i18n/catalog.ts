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
  seoTitle: string;
  seoDescription: string;
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
    backToModelsLabel: string;
    seriesLabel: string;
    modelLabel: string;
    typeLabel: string;
    moqLabel: string;
    unitPriceLabel: string;
    wholesaleLabel: string;
    inquiryCta: string;
    oemInquiryCta: string;
    viewAllLabel: string;
    showLessLabel: string;
    imageUnavailableLabel: string;
    oemEyebrow: string;
    oemHeading: string;
    oemBody: string;
    relatedHeading: string;
    notFound: string;
  };
  families: readonly CatalogFamilyContent[];
}

export interface SharedDetailContent {
  rfq: {
    customizationAction: string;
    localNotice: string;
    close: string;
    reference: string;
    stepsLabel: string;
    steps: Record<'requirements' | 'contact' | 'review', string>;
    contextChanged: string;
    quantityPolicy: string;
    deliveryDate: string;
    customizationTypes: string;
    types: Record<'logo' | 'packaging' | 'material' | 'color' | 'certification' | 'other', string>;
    customBrief: string;
    notes: string;
    contactName: string;
    email: string;
    company: string;
    country: string;
    countryPlaceholder: string;
    countryEmpty: string;
    countryClear: string;
    countryHelp: string;
    notSpecified: string;
    reviewNotice: string;
    back: string;
    sendUnavailable: string;
    sendLocal: string;
    send: string;
    sending: string;
    saved: string;
    submitErrors: Record<string, string>;
    continue: string;
    review: string;
    errors: Record<string, string>;
  };
  previewLabel: string;
  previewNote: string;
  backLabel: string;
  configurationLabel: string;
  selectedLabel: string;
  variantLabel: string;
  noVariants: string;
  pendingLabel: string;
  invalidVariant: string;
  clearLabel: string;
  identityLabel: string;
  availabilityLabel: string;
  unknownAvailability: string;
  onHandLabel: string;
  sellableLabel: string;
  sourceNote: string;
  specificationsLabel: string;
  keyFactsLabel: string;
  packagingLabel: string;
  supplierNotesLabel: string;
  specificationBasis: string;
  noFacts: string;
  descriptionLabel: string;
  noDescription: string;
  inquiryLabel: string;
  inquiryUnavailable: string;
  pricingNote: string;
  quantityLabel: string;
  quantityHelp: string;
  quantityError: string;
  sourceQuotesLabel: string;
  productQuoteLabel: string;
  variantQuoteLabel: string;
  noSourceQuote: string;
  quoteSelectVariant: string;
  quoteEnterQuantity: string;
  quoteBelowMoq: string;
  quoteNoTier: string;
  quoteNegotiable: string;
  quoteMoqLabel: string;
  quoteUnitLabel: string;
  quoteTierQuantityLabel: string;
  quoteTierPriceLabel: string;
  quoteSupplierLabel: string;
  quoteRegularLabel: string;
  quotePromotionLabel: string;
  imagesNote: string;
  loadingLabel: string;
  errorLabel: string;
  refreshLabel: string;
  notFound: string;
  retryLabel: string;
  previousLabel: string;
  nextLabel: string;
  pageLabel: string;
  partialLabel: string;
  imageUnavailableLabel: string;
}

interface MarkdownModule {
  frontmatter: CatalogContent & { sharedDetail: SharedDetailContent };
}

const modules = import.meta.glob<MarkdownModule>('./content/catalog/*.md', { eager: true });
const byLocale = new Map<string, CatalogContent>();
const sharedByLocale = new Map<string, SharedDetailContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) {
    const { sharedDetail, ...catalog } = mod.frontmatter;
    byLocale.set(locale, catalog);
    sharedByLocale.set(locale, sharedDetail);
  }
}

export const DEFAULT_CATALOG_LOCALE = 'en-US';

export function getSharedDetailContent(locale = DEFAULT_CATALOG_LOCALE): SharedDetailContent {
  const content = sharedByLocale.get(locale) ?? sharedByLocale.get(DEFAULT_CATALOG_LOCALE);
  if (!content) throw new Error('Missing shared catalog detail copy');
  return content;
}

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
