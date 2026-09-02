/**
 * Presentational Headphones product detail (MIU 11).
 *
 * Renders the Gallery media contract, the spec sheet, the existing PriceBlock
 * entitlement behavior, a programmatically focusable heading, and a Back
 * button. Every enquiry command is a plain anchor to the homepage OEM enquiry
 * section — no modal, no login prerequisite, no simulated durable success.
 *
 * Both detail columns are `min-w-0` tracks so long titles, descriptions, and
 * spec values wrap inside the 768–1024px layouts instead of clipping or
 * widening the page. Focus movement (heading focus after expansion, card
 * focus restoration on Back) belongs to the MIU 13 controller.
 */
import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import {
  CatalogDetail,
  type CatalogDetailFact,
} from '../../catalog/presentation/CatalogDetail.tsx';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { DEFAULT_ALIBABA_PRICING_LABELS } from './AlibabaCatalogPricingBlock.tsx';
import { Gallery } from './Gallery.tsx';
import type { Product } from './catalog-types.ts';

export interface HeadphonesProductDetailProps {
  product: Product;
  detail: HeadphonesContent['detail'];
  /** Category display label, resolved by the caller from the list contract. */
  categoryLabel: string;
  onBack: () => void;
}

export function HeadphonesProductDetail({
  product,
  detail,
  categoryLabel,
  onBack,
}: HeadphonesProductDetailProps) {
  const { alibabaPrimarySourceKey, ...unlinkedProduct } = product;
  const pricing = resolveCatalogPricing(
    alibabaPrimarySourceKey == null ? unlinkedProduct : product,
    createAlibabaPricingAdapter(),
  );
  const moq = pricing.source === 'alibaba' ? pricing.pricing.sourceMoq : product.moq;
  const factRows: CatalogDetailFact[] = [
    ...(product.series
      ? [{ key: 'series', label: detail.seriesLabel, value: product.series }]
      : []),
    ...(product.modType ? [{ key: 'type', label: detail.typeLabel, value: product.modType }] : []),
    ...(moq !== undefined
      ? [
          {
            key: 'moq',
            label: detail.moqLabel,
            value: moq,
            ...(pricing.source === 'alibaba' ? { marker: 'supplier-moq' as const } : {}),
          },
        ]
      : []),
    ...(product.productCode
      ? [{ key: 'product-code', label: 'Product Code', value: product.productCode }]
      : []),
  ];

  return (
    <CatalogDetail
      product={product}
      pricing={pricing}
      facts={{
        categoryLabel,
        rows: factRows,
        backLabel: detail.backToModelsLabel,
        scalarLabels: {
          wholesalePrice: detail.wholesaleLabel,
          unitPrice: detail.unitPriceLabel,
        },
        quoteLabel: detail.inquiryCta,
        inquiryLabel: detail.inquiryCta,
        sourcePricingLabels: DEFAULT_ALIBABA_PRICING_LABELS,
        sourceUpdated: product.alibabaCatalogPricing?.sourceUpdatedAt,
      }}
      media={
        <Gallery
          images={product.images ?? []}
          alt={product.name}
          productId={product._id}
          viewAllLabel={detail.viewAllLabel}
          showLessLabel={detail.showLessLabel}
          unavailableLabel={detail.imageUnavailableLabel}
        />
      }
      onBack={onBack}
    />
  );
}
