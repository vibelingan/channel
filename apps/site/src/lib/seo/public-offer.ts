import { WebsiteDetailPricingSchema } from '@vibelingan-channel/shared/catalog-detail';
import { canonicalUrl } from './page.ts';
import { productPath } from './product-identity.ts';
import type { ProductSnapshotEntry } from './product-snapshot.ts';

export type OfferExclusion =
  | 'not-public'
  | 'no-approved-detail'
  | 'no-website-price'
  | 'invalid-website-price'
  | 'negotiable'
  | 'unavailable'
  | 'minimum-order-not-one'
  | 'range-not-single-price'
  | 'quantity-dependent'
  | 'unsupported-currency'
  | 'no-public-image';
type Ordinary = { status: 'ordinary'; reason: OfferExclusion };
type UnitPrice = { status: 'eligible'; currency: string; amount: string };
const ordinary = (reason: OfferExclusion): Ordinary => ({ status: 'ordinary', reason });
const currencies = new Set(Intl.supportedValuesOf('currency'));

/** Google may omit quantity conditions. Only a stated one-piece, uniform website price qualifies. */
export function websiteUnitPrice(input: unknown): UnitPrice | Ordinary {
  if (input === undefined) return ordinary('no-website-price');
  const decoded = WebsiteDetailPricingSchema.safeParse(input);
  if (!decoded.success) return ordinary('invalid-website-price');
  const p = decoded.data.pricing;
  if (p.mode === 'negotiable' || p.mode === 'unavailable') return ordinary(p.mode);
  if (p.minimumOrderQuantity !== 1) return ordinary('minimum-order-not-one');
  if (!currencies.has(p.currency)) return ordinary('unsupported-currency');
  let amount: number;
  switch (p.mode) {
    case 'fixed':
      amount = p.amountMinor;
      break;
    case 'range':
      if (p.minimumAmountMinor !== p.maximumAmountMinor) return ordinary('range-not-single-price');
      amount = p.minimumAmountMinor;
      break;
    case 'tiered': {
      const first = p.tiers[0];
      if (!first || first.minimumQuantity !== 1) return ordinary('quantity-dependent');
      amount = first.unitAmountMinor;
      for (const [i, tier] of p.tiers.entries()) {
        const next = p.tiers[i + 1];
        if (
          tier.unitAmountMinor !== amount ||
          (next
            ? tier.maximumQuantity === undefined ||
              tier.maximumQuantity + 1 !== next.minimumQuantity
            : tier.maximumQuantity !== undefined)
        )
          return ordinary('quantity-dependent');
      }
      break;
    }
    default: {
      const exhaustive: never = p;
      return exhaustive;
    }
  }
  // The public pricing contract uses hundredths, including currencies such as JPY.
  const minor = BigInt(amount);
  return {
    status: 'eligible',
    currency: p.currency,
    amount: `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`,
  };
}

type ProductNode = {
  '@type': 'Product';
  '@id': string;
  url: string;
  name: string;
  description: string;
  image: string[];
  offers: {
    '@type': 'Offer';
    url: string;
    priceSpecification: {
      '@type': 'UnitPriceSpecification';
      price: string;
      priceCurrency: string;
      referenceQuantity: { '@type': 'QuantitativeValue'; value: 1; unitCode: 'C62' };
    };
  };
};

/** Only approved website pricing enters JSON-LD. Legacy and supplier fields are never fallbacks. */
export function publicProductRichResult(
  entry: ProductSnapshotEntry,
  origin: string,
  description: string,
): { status: 'eligible'; schema: ProductNode } | Ordinary {
  if (entry.product.published === false) return ordinary('not-public');
  const detail = entry.detail;
  if (!detail?.revision || detail.revision !== entry.revision || detail._id !== entry.product._id)
    return ordinary('no-approved-detail');
  const price = websiteUnitPrice(detail.websitePricing);
  if (price.status === 'ordinary') return price;
  const images = detail.images.filter((url) => /^\/api\/images\/[A-Za-z0-9_-]+$/.test(url));
  if (!images.length) return ordinary('no-public-image');
  const url = canonicalUrl(productPath(detail._id), origin);
  return {
    status: 'eligible',
    schema: {
      '@type': 'Product',
      '@id': `${url}#product`,
      url,
      name: detail.name,
      description,
      image: images.map((path) => new URL(path, origin).href),
      offers: {
        '@type': 'Offer',
        url,
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: price.amount,
          priceCurrency: price.currency,
          referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitCode: 'C62' },
        },
      },
    },
  };
}
