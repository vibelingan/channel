import { useQuery } from '@tanstack/react-query';
import { type CollectionDoc, productFamilyForDoc } from '@vibelingan-channel/shared';
import { ADMIN_PRODUCT_FAMILY_LABELS } from './product-family-tabs.ts';
import {
  savedProductSubcategories,
  savedSubcategoriesText,
  taxonomyQuery,
} from './taxonomy-ui-state.ts';

/** Shows the saved record, not form state, so unsaved edits never look published. */
export function SavedClassificationSummary({ product }: { product: CollectionDoc }) {
  const family = productFamilyForDoc(product);
  const registry = useQuery({
    ...taxonomyQuery(family ?? 'headphones'),
    enabled: family !== null,
  });
  const saved = family && registry.data ? savedProductSubcategories(product, registry.data) : null;

  return (
    <section
      aria-labelledby="saved-classification-title"
      data-saved-classification
      className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"
    >
      <h3 id="saved-classification-title" className="font-semibold text-slate-900">
        Saved website classification
      </h3>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500">Main category</dt>
        <dd className="text-slate-900">
          {family ? ADMIN_PRODUCT_FAMILY_LABELS[family] : 'Needs classification'}
        </dd>
        <dt className="text-slate-500">Subcategories</dt>
        <dd className="min-w-0 break-words text-slate-900" data-saved-subcategories>
          {!family ? (
            'None'
          ) : registry.error ? (
            <span role="alert" className="text-red-700">
              Subcategories could not be loaded.{' '}
              <button
                type="button"
                onClick={() => void registry.refetch()}
                className="min-h-11 font-medium underline"
              >
                Retry subcategories
              </button>
            </span>
          ) : !saved ? (
            <output className="text-slate-500">Loading subcategories…</output>
          ) : saved.kind === 'invalid' ? (
            <span className="text-amber-800">
              Invalid saved subcategories. Use Classify to replace them.
            </span>
          ) : (
            savedSubcategoriesText(saved)
          )}
        </dd>
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Last saved values; unsaved edits in this form are not reflected. Use Classify in the product
        list to change subcategories.
      </p>
    </section>
  );
}
