import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import { CatalogCard } from '../../catalog/presentation/CatalogCard.tsx';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { DEFAULT_ALIBABA_PRICING_LABELS } from './AlibabaCatalogPricingBlock.tsx';
import type { Product } from './catalog-types.ts';

/**
 * Presentational Headphones catalog card (MIU 10).
 *
 * A semantic in-page expansion button: activating it opens the product's
 * detail section on the same page (wired by the MIU 13 controller), so it is
 * a `<button>`, never a link. Media flows through ProductMedia's ordered
 * source/fallback contract — lazy and low-priority so a page of cards does
 * not stampede the gated image function.
 *
 * Hierarchy is calibrated and browser-asserted: product identity strongest,
 * unit price display 14px/600 (`text-sm font-semibold`), the view-details
 * action 12px/500 (`text-xs font-medium`).
 */

export interface HeadphonesProductCardProps {
  product: Product;
  list: HeadphonesContent['list'];
  imageUnavailableLabel: string;
  onOpen: (productId: string) => void;
}

function legacyCardPricingInput(product: Product) {
  const { alibabaPrimarySourceKey, ...unlinkedProduct } = product;
  if (alibabaPrimarySourceKey != null) return product;
  return {
    ...unlinkedProduct,
    manualCatalogPricing: undefined,
    wholesalePrice: undefined,
  };
}

export function HeadphonesProductCard({
  product,
  list,
  imageUnavailableLabel,
  onOpen,
}: HeadphonesProductCardProps) {
  const pricing = resolveCatalogPricing(
    legacyCardPricingInput(product),
    createAlibabaPricingAdapter(),
  );
  return (
    <CatalogCard
      product={product}
      pricing={pricing}
      facts={{
        identifier: product.modName,
        moq: pricing.source === 'alibaba' ? pricing.pricing.sourceMoq : product.moq,
        moqLabel: list.moqLabel,
        unavailableLabel: DEFAULT_ALIBABA_PRICING_LABELS.unavailableLabel,
        actionLabel: list.viewDetail,
        imageUnavailableLabel,
      }}
      onActivate={onOpen}
    />
  );
}
