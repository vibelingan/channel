import type { InquiryDetail } from '@vibelingan-channel/shared/catalog-inquiry';
import type { CatalogOfferPricing } from '@vibelingan-channel/shared/catalog-pricing';
import { countryName } from '@vibelingan-channel/shared/countries';
import { formatCatalogQuoteAmount as money } from '../../../catalog/presentation/CatalogQuoteConditions.tsx';

function Pricing({ pricing }: { pricing: CatalogOfferPricing }) {
  switch (pricing.mode) {
    case 'fixed':
      return <p>{money(pricing.amountMinor, pricing.currency)} / unit</p>;
    case 'range':
      return (
        <p>
          {money(pricing.minimumAmountMinor, pricing.currency)} –{' '}
          {money(pricing.maximumAmountMinor, pricing.currency)} / unit
        </p>
      );
    case 'tiered':
      return (
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">Quantity price tiers</caption>
          <thead>
            <tr>
              <th>Quantity</th>
              <th>Unit quote</th>
            </tr>
          </thead>
          <tbody>
            {pricing.tiers.map((tier) => (
              <tr key={tier.minimumQuantity}>
                <td className="py-2">
                  {tier.minimumQuantity}
                  {tier.maximumQuantity === undefined ? '+' : `–${tier.maximumQuantity}`}
                </td>
                <td>{money(tier.unitAmountMinor, pricing.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'negotiable':
      return <p>Negotiable — confirm with sales</p>;
    case 'unavailable':
      return <p>No usable source price</p>;
  }
}
/** Printable customer inquiry, deliberately excludes internal events and statuses.
 * All text is escaped by React. No external image fetches/private storage URLs. */
export function InquirySummary({ item }: { item: InquiryDetail }) {
  const { fields, snapshot } = item;
  const groups = [
    { label: 'Product-level source quotes', offers: snapshot.productOffers },
    { label: 'Selected configuration source quotes', offers: snapshot.variant?.offers ?? [] },
  ];
  return (
    <article
      className="space-y-6 break-words text-sm leading-6 text-slate-800"
      data-inquiry-summary
    >
      <header>
        <h2 className="font-display text-xl font-semibold">Product inquiry summary</h2>
        <p className="mt-1 text-slate-600">
          Not a quotation, invoice or order. Final price, availability and shipping require
          confirmation.
        </p>
        <p className="mt-2 font-mono text-xs">Reference: {item.id}</p>
        <p>
          Submitted:{' '}
          {new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'Asia/Hong_Kong',
          }).format(new Date(item.createdAt))}{' '}
          (Hong Kong)
        </p>
      </header>
      <section>
        <h3 className="font-semibold text-base">{snapshot.productName}</h3>
        <p>
          {fields.intent === 'customization'
            ? 'Customization inquiry'
            : 'Product / configuration inquiry'}
        </p>
        <p className="text-xs text-slate-500">
          Product: {snapshot.productId} · Revision: {snapshot.revision}
        </p>
        {snapshot.variant && (
          <>
            <p className="text-xs text-slate-500">
              Configuration: {snapshot.variant.id}
              {snapshot.variant.sku ? ` · SKU: ${snapshot.variant.sku}` : ''}
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {snapshot.variant.options.map((option, i) => (
                <div key={`${option.name}-${i}`} className="rounded-lg bg-slate-50 p-3">
                  <dt className="text-xs text-slate-500">{option.name}</dt>
                  <dd className="font-medium">{option.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>
      <section>
        <h3 className="font-semibold">Requirements</h3>
        <p>Quantity: {fields.quantity}</p>
        <p>Requested date: {fields.deliveryDate || 'Not specified'}</p>
        {fields.customizationTypes.length > 0 && (
          <p>Customization: {fields.customizationTypes.join(', ')}</p>
        )}
        <p className="whitespace-pre-wrap">{fields.brief || 'No additional requirements.'}</p>
      </section>
      <section>
        <h3 className="font-semibold">Contact</h3>
        <p>
          {fields.contactName} · {fields.company}
        </p>
        <p>{fields.email}</p>
        <p>
          Company country / region: {countryName(fields.country)} ({fields.country})
        </p>
        <p className="text-xs text-slate-500">
          First-contact details, not a confirmed shipping or billing address.
        </p>
      </section>
      <section>
        <h3 className="font-semibold">Source quotes at submission</h3>
        {groups.every((group) => !group.offers.length) && (
          <p>No usable price was recorded. Confirm with sales.</p>
        )}
        {groups
          .filter((group) => group.offers.length)
          .map((group) => (
            <div key={group.label} className="mt-3">
              <h4 className="text-sm font-medium">{group.label}</h4>
              {group.offers.map((offer, index) => (
                <div
                  key={`${offer.kind}-${index}`}
                  className="mt-2 rounded-lg border border-slate-200 p-3"
                >
                  <p className="text-xs capitalize text-slate-500">{offer.kind} · source quote</p>
                  {offer.pricing.minimumOrderQuantity && (
                    <p>Minimum order quantity: {offer.pricing.minimumOrderQuantity}</p>
                  )}
                  <Pricing pricing={offer.pricing} />
                </div>
              ))}
            </div>
          ))}
      </section>
    </article>
  );
}
