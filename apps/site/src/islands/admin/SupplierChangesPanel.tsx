import type {
  SupplierReview,
  SupplierReviewPart,
  SupplierReviewPartName,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { type SupplierChoices, formatPricings, undecidedParts } from './supplier-review-ui.ts';
import { useAdminImagePreviews } from './use-admin-image-previews.ts';

const PART_LABELS: Record<SupplierReviewPartName, string> = {
  description: 'Description',
  gallery: 'Product photos',
  descriptionImages: 'Description photos',
};
const ORIGIN_LABELS: Record<SupplierReviewPart['origin'], string> = {
  supplier: 'From Alibaba at the last approval',
  admin: 'Edited here',
  unknown: 'Website version',
};

function Photos({
  ids,
  urls,
  label,
}: { ids?: readonly string[]; urls?: readonly string[]; label: string }) {
  const previews = useAdminImagePreviews(ids ?? []);
  const sources = urls
    ? alibabaSourcePreviewUrls(urls, 18)
    : (ids ?? []).map((id) => previews.urls[id]).filter((url): url is string => Boolean(url));
  if ((ids ?? urls ?? []).length === 0) return <p className="text-slate-500">No photos</p>;
  return (
    <ul className="flex flex-wrap gap-2">
      {sources.map((src, index) => (
        <li key={src}>
          <img
            src={src}
            alt={`${label} ${index + 1}`}
            className="h-14 w-14 rounded border border-slate-200 object-contain"
            loading="lazy"
          />
        </li>
      ))}
    </ul>
  );
}

function Value({ part, side }: { part: SupplierReviewPart; side: 'website' | 'incoming' }) {
  if (part.part === 'description') {
    const text = side === 'website' ? part.website.text : part.incoming.text;
    return <p className="whitespace-pre-line break-words text-slate-800">{text || '—'}</p>;
  }
  return side === 'website' ? (
    <Photos ids={part.website.imageIds ?? []} label="Website" />
  ) : (
    <Photos urls={part.incoming.urls ?? []} label="Alibaba" />
  );
}

/**
 * Supplier changes on a flagged product (DEC-19): for each website part that
 * differs from Alibaba's new value, Keep or Use Alibaba's. Prices,
 * configurations and specifications are taken on approval, shown old → new.
 */
export function SupplierChangesPanel({
  review,
  choices,
  busyPart,
  error,
  onKeep,
  onUseIncoming,
}: {
  review: SupplierReview;
  choices: SupplierChoices;
  busyPart: SupplierReviewPartName | null;
  error: string;
  onKeep: (part: SupplierReviewPart) => void;
  onUseIncoming: (part: SupplierReviewPart) => void;
}) {
  const undecided = undecidedParts(review, choices);
  const changes = review.changes;
  const taken = [
    ...(changes?.prices ?? []).map(
      (entry) =>
        `${entry.configuration}: ${formatPricings(entry.before)} → ${formatPricings(entry.after)}`,
    ),
    ...(changes?.productPrice
      ? [
          `Product price: ${formatPricings(changes.productPrice.before)} → ${formatPricings(changes.productPrice.after)}`,
        ]
      : []),
    ...(changes?.configurationsAdded.length
      ? [`Added: ${changes.configurationsAdded.join(', ')}`]
      : []),
    ...(changes?.configurationsRemoved.length
      ? [`Removed: ${changes.configurationsRemoved.join(', ')}`]
      : []),
    ...(changes?.options.length ? [`Options changed: ${changes.options.join(', ')}`] : []),
    ...(changes?.facts ? ['Specifications changed'] : []),
  ];
  return (
    <section
      aria-labelledby="supplier-changes-title"
      data-supplier-changes
      className="space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
    >
      <h3 id="supplier-changes-title" className="text-base font-semibold">
        Supplier changes
      </h3>
      {review.parts.map((part) => {
        const chosen =
          choices[part.part]?.incomingDigest === part.incomingDigest
            ? choices[part.part]?.choice
            : part.decision;
        return (
          <fieldset
            key={part.part}
            data-supplier-part={part.part}
            className="space-y-2 rounded-md border border-amber-200 bg-white p-3"
          >
            <legend className="px-1 font-semibold">{PART_LABELS[part.part]}</legend>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">
                  On the website · {ORIGIN_LABELS[part.origin]}
                </p>
                <Value part={part} side="website" />
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">New from Alibaba</p>
                <Value part={part} side="incoming" />
              </div>
            </div>
            {chosen && (
              <p className="text-green-800">
                {chosen === 'keep'
                  ? 'Decided: kept the website version'
                  : 'Decided: using Alibaba’s version'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busyPart !== null}
                onClick={() => onKeep(part)}
                aria-pressed={chosen === 'keep'}
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                Keep website version
              </button>
              <button
                type="button"
                disabled={busyPart !== null}
                onClick={() => onUseIncoming(part)}
                aria-pressed={chosen === 'incoming'}
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 font-medium disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                {busyPart === part.part ? 'Importing photos…' : 'Use Alibaba’s'}
              </button>
            </div>
          </fieldset>
        );
      })}
      {taken.length > 0 && (
        <div>
          <p className="font-semibold">Taken from Alibaba on approval</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {taken.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <output className="block">
        {undecided.length === 0
          ? 'All changes have a decision. Save to apply them.'
          : `${undecided.length} ${undecided.length === 1 ? 'change still needs' : 'changes still need'} a decision; until then the product stays flagged Changed.`}
      </output>
    </section>
  );
}
