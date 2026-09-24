import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CatalogClassificationAssignmentRequest,
  type CatalogClassificationAssignmentResult,
  type CollectionDoc,
  PRODUCT_FAMILY_OPTIONS,
  type ProductFamily,
  isProductFamily,
  productFamilyForDoc,
  readProductSubcategories,
  validateProductSubcategories,
} from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { BatchUpdateFeedback } from './BatchUpdateFeedback.tsx';
import {
  type BatchUpdateResult,
  type CategorySuggestion,
  assignmentCall,
  categorySuggestionMatchesProduct,
  fetchCategorySuggestion,
  publishConfirmedClassification,
} from './api.ts';
import {
  classificationChoices,
  classificationRequest,
  initialClassification,
  summarizeAssignment,
  taxonomyQuery,
} from './taxonomy-ui-state.ts';

export interface ProductClassificationEditorProps {
  products: readonly CollectionDoc[];
  busy?: boolean;
  publishOnSave?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSaved: () => void;
  onCancel?: () => void;
}

const buttonClass =
  'min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50';
const resultLabels: Record<
  CatalogClassificationAssignmentResult['results'][number]['status'],
  string
> = {
  saved: 'Saved',
  conflict: 'Changed since preview; refresh needed',
  invalid: 'Invalid assignment',
  missing: 'Product no longer exists',
  forbidden: 'Not permitted',
  unknown: 'Not confirmed; refresh needed',
  notattempted: 'Not attempted; refresh needed',
};

export function ProductClassificationEditor({
  products,
  busy = false,
  publishOnSave = false,
  onBusyChange,
  onSaved,
  onCancel,
}: ProductClassificationEditorProps) {
  const client = useQueryClient();
  const queries = useQueries({ queries: PRODUCT_FAMILY_OPTIONS.map(taxonomyQuery) });
  const singleProduct = products.length === 1 ? products[0] : undefined;
  const suggestionQuery = useQuery({
    queryKey: [
      'catalog-category-suggestion',
      singleProduct?._id,
      singleProduct?.updatedAt,
      singleProduct?.alibabaPrimarySourceKey,
    ],
    queryFn: ({ signal }) => fetchCategorySuggestion(singleProduct?._id ?? '', signal),
    enabled: false,
    retry: false,
    networkMode: 'always',
  });
  const [appliedSuggestion, setAppliedSuggestion] = useState<Extract<
    CategorySuggestion,
    { status: 'ready' }
  > | null>(null);
  const suggestionResponse = suggestionQuery.data;
  const suggestion: Extract<CategorySuggestion, { status: 'ready' }> | null =
    suggestionResponse && suggestionResponse.status === 'ready' ? suggestionResponse : null;
  const suggestionTaxonomy = suggestion
    ? queries[PRODUCT_FAMILY_OPTIONS.indexOf(suggestion.family)]
    : undefined;
  const suggestionRegistry = suggestionTaxonomy?.data;
  const suggestionCurrent = Boolean(
    suggestion &&
      singleProduct &&
      suggestionRegistry &&
      !suggestionQuery.error &&
      !suggestionTaxonomy?.error &&
      !suggestionTaxonomy?.isFetching &&
      categorySuggestionMatchesProduct(suggestion, singleProduct) &&
      suggestionRegistry.revision === suggestion.taxonomyRevision &&
      validateProductSubcategories(
        suggestion.family,
        suggestion.subcategoryIds,
        suggestionRegistry,
      ),
  );
  const [family, setFamily] = useState<ProductFamily>(
    () => productFamilyForDoc(products[0] ?? {}) ?? 'headphones',
  );
  const [mode, setMode] = useState<CatalogClassificationAssignmentRequest['operation']>('replace');
  const [publish, setPublish] = useState(publishOnSave);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [confirmation, setConfirmation] = useState<CatalogClassificationAssignmentRequest | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<CatalogClassificationAssignmentResult['results']>([]);
  const [publicationResult, setPublicationResult] = useState<BatchUpdateResult | null>(null);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const refreshBaseline = useRef(products);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const mutation = useMutation({
    mutationFn: (command: CatalogClassificationAssignmentRequest) =>
      assignmentCall(command, undefined, appliedSuggestion ?? undefined),
    retry: false,
    networkMode: 'always',
  });
  const query = queries[PRODUCT_FAMILY_OPTIONS.indexOf(family)];
  const registry = query.data;
  const preload = registry ? initialClassification(products, registry) : { ids: [], error: null };
  const ids = mode === 'clear' ? [] : (selected ?? preload.ids);
  const locked = busy || pending || finished || suggestionQuery.isFetching;
  let request: CatalogClassificationAssignmentRequest | null = null;
  let validation = preload.error;
  if (
    appliedSuggestion &&
    (!singleProduct ||
      !categorySuggestionMatchesProduct(appliedSuggestion, singleProduct) ||
      registry?.family !== appliedSuggestion.family ||
      registry.revision !== appliedSuggestion.taxonomyRevision)
  )
    validation =
      'Product source or categories changed since the suggestion. Cancel and review the product again.';
  if (registry && !validation) {
    try {
      const classification = classificationRequest(products, registry, mode, ids);
      request = publish ? { ...classification, includeSavedRevision: true } : classification;
    } catch (error) {
      validation = error instanceof Error ? error.message : 'Invalid assignment.';
    }
  }
  const confirmationCurrent =
    confirmation !== null && JSON.stringify(confirmation) === JSON.stringify(request);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyCallback.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (!refreshRequested || products === refreshBaseline.current || pending || inFlight.current)
      return;
    setRefreshRequested(false);
    setFinished(false);
    setResults([]);
    setPublicationResult(null);
    setMessage('');
    setSelected(null);
    setAppliedSuggestion(null);
    setConfirmation(null);
    setMode('replace');
    setFamily(productFamilyForDoc(products[0] ?? {}) ?? 'headphones');
  }, [products, refreshRequested, pending]);

  async function refreshProducts() {
    if (pending || busy || inFlight.current) return;
    inFlight.current = true;
    refreshBaseline.current = products;
    setPending(true);
    setFinished(true);
    setConfirmation(null);
    busyCallback.current?.(true);
    try {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['list', 'products'] }),
        client.invalidateQueries({ queryKey: ['catalog-taxonomy'] }),
      ]);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPending(false);
        busyCallback.current?.(false);
        setRefreshRequested(true);
        setMessage('Refresh requested. Assignment stays blocked until refreshed products arrive.');
        onSaved();
      }
    }
  }

  async function save() {
    if (
      !confirmation ||
      !confirmationCurrent ||
      !request ||
      locked ||
      query.isFetching ||
      query.error ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setPending(true);
    busyCallback.current?.(true);
    setConfirmation(null);
    let result: CatalogClassificationAssignmentResult;
    try {
      result = await mutation.mutateAsync(confirmation);
    } catch {
      if (mounted.current) {
        setFinished(true);
        setMessage(
          'Assignment was not confirmed. Refresh products before trying again; some changes may have been saved.',
        );
      }
      inFlight.current = false;
      if (mounted.current) {
        setPending(false);
        busyCallback.current?.(false);
      }
      return;
    }
    if (!mounted.current) {
      inFlight.current = false;
      return;
    }
    setResults(result.results);
    setFinished(true);
    const { uncertain, allSaved } = summarizeAssignment(result);
    setMessage(
      uncertain
        ? 'Some results are not confirmed. Refresh products before trying again.'
        : allSaved
          ? publish
            ? 'Classification saved. Publishing selected products...'
            : 'Classification saved. Drafts were not published.'
          : 'Review the product results and refresh before another assignment.',
    );
    try {
      if (publish && allSaved) {
        const publication = publishConfirmedClassification(confirmation, result);
        if (publication) {
          const outcome = await publication;
          if (mounted.current) {
            setPublicationResult(outcome);
            setMessage(
              outcome.failures.length
                ? `${outcome.updated} published; ${outcome.failures.length} need attention. Refresh statuses before retrying. Confirmed publications are not rolled back.`
                : `${outcome.updated} products classified and published.`,
            );
          }
        } else {
          setMessage(
            'Publication blocked: assignment results were not confirmed. Refresh products.',
          );
        }
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ['list', 'products'] }),
        client.invalidateQueries({ queryKey: ['catalog-taxonomy'] }),
      ]);
    } catch {
      if (mounted.current)
        setMessage('Publication could not be confirmed. Refresh product statuses before retrying.');
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPending(false);
        busyCallback.current?.(false);
        if (allSaved && !publish) onSaved();
      }
    }
  }

  return (
    <section
      aria-label="Product classification"
      className="min-w-0 space-y-4 border-t border-brand-200 py-4"
    >
      <h2 className="text-lg font-semibold text-ink">Website classification</h2>
      <p className="text-sm text-slate-600">
        {products.length} selected products.
        {!publish && ' Drafts will not be published.'}
      </p>
      {publishOnSave && (
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={publish}
            disabled={locked}
            onChange={(event) => {
              setPublish(event.currentTarget.checked);
              setConfirmation(null);
            }}
          />
          Publish only after all classifications are confirmed
        </label>
      )}
      {singleProduct && typeof singleProduct.alibabaPrimarySourceKey === 'string' && (
        <div
          aria-label="Source classification suggestion"
          className="min-w-0 space-y-2 border-y border-slate-200 py-3 text-sm"
        >
          <button
            type="button"
            className={buttonClass}
            disabled={locked}
            onClick={() => {
              setConfirmation(null);
              void suggestionQuery.refetch();
            }}
          >
            {suggestionQuery.isFetching ? 'Loading suggestion...' : 'Load source suggestion'}
          </button>
          {suggestionQuery.error && <p role="alert">{suggestionQuery.error.message}</p>}
          {suggestionQuery.data && suggestionQuery.data.status !== 'ready' && (
            <output className="block">
              No applicable source suggestion ({suggestionQuery.data.status}).
            </output>
          )}
          {suggestion && (
            <>
              <p className="break-words">
                {suggestionRegistry?.name ?? suggestion.family}:{' '}
                {suggestion.subcategoryIds
                  .map(
                    (id) =>
                      suggestionRegistry?.children.find((child) => child.id === id)?.name ?? id,
                  )
                  .join(', ') || 'No subcategories'}
              </p>
              <p className="break-all">
                Source: {suggestion.source.primarySourceKey} / {suggestion.source.sourceCategoryId}
              </p>
              <p className="break-all">
                Mapping: {suggestion.mapping.id} / {suggestion.mapping.revision}
              </p>
              <p>
                Product snapshot: {suggestion.productUpdatedAt}. Category revision:{' '}
                {suggestion.taxonomyRevision}.
              </p>
              {!suggestionCurrent && (
                <p role="alert">
                  Suggestion is stale or categories are unavailable. Refresh before applying.
                </p>
              )}
              <button
                type="button"
                className={buttonClass}
                disabled={locked || !suggestionCurrent}
                onClick={() => {
                  if (locked || !suggestionCurrent) return;
                  setFamily(suggestion.family);
                  setMode('replace');
                  setSelected([...suggestion.subcategoryIds]);
                  setAppliedSuggestion(suggestion);
                  setConfirmation(null);
                  setMessage('Suggestion applied to draft only. Nothing has been saved.');
                }}
              >
                Apply suggestion
              </button>
            </>
          )}
          {appliedSuggestion && (
            <output className="block break-all">
              Draft uses source category {appliedSuggestion.source.sourceCategoryId}, mapping
              revision {appliedSuggestion.mapping.revision}. Source and mapping changes are not
              locked when saving this manual assignment.
            </output>
          )}
        </div>
      )}
      <fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          label="Website main category"
          required
          placeholder=""
          disabled={locked}
          value={family}
          options={PRODUCT_FAMILY_OPTIONS.map((item, index) => ({
            value: item,
            label: queries[index].data?.name ?? item,
          }))}
          onChange={(next) => {
            if (!isProductFamily(next) || next === family) return;
            setFamily(next);
            setSelected([]);
            setAppliedSuggestion(null);
            setConfirmation(null);
            setMessage('Subcategory selection cleared for the new main category.');
          }}
        />
        <Select
          label="Assignment mode"
          required
          placeholder=""
          disabled={locked}
          value={mode}
          options={[
            { value: 'replace', label: 'Replace subcategories' },
            { value: 'append', label: 'Append subcategories' },
            { value: 'clear', label: 'Clear subcategories' },
          ]}
          onChange={(next) => {
            if (next !== 'replace' && next !== 'append' && next !== 'clear') return;
            setMode(next);
            setSelected([]);
            setAppliedSuggestion(null);
            setConfirmation(null);
            setMessage('');
          }}
        />
      </fieldset>
      {query.isPending && <output className="block">Loading categories...</output>}
      {query.error && (
        <div role="alert" className="space-y-2 text-sm text-red-700">
          <p>{query.error.message}</p>
          <button
            type="button"
            className={buttonClass}
            disabled={pending || query.isFetching}
            onClick={() => {
              setConfirmation(null);
              void query.refetch();
            }}
          >
            Retry loading categories
          </button>
        </div>
      )}
      {registry && (
        <>
          <fieldset
            disabled={locked || mode === 'clear' || query.isFetching || Boolean(query.error)}
            className="min-w-0"
          >
            <legend className="mb-2 text-sm font-semibold">{registry.name} subcategories</legend>
            <ul className="grid min-w-0 grid-cols-1 gap-x-4 sm:grid-cols-2">
              {classificationChoices(products, registry, ids)
                .filter((choice) => choice.child.status === 'active' || choice.current)
                .map(({ child, selected: checked, disabled }) => (
                  <li key={child.id} className="min-w-0 border-b border-slate-200">
                    <label className="flex min-h-11 items-center gap-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={checked}
                        value={child.id}
                        onChange={(event) => {
                          setSelected(
                            event.currentTarget.checked
                              ? [...ids, child.id]
                              : ids.filter((id) => id !== child.id),
                          );
                          setAppliedSuggestion(null);
                          setConfirmation(null);
                        }}
                      />
                      <span className="min-w-0 break-words">
                        {child.name}
                        {child.status === 'archived' ? ' (archived)' : ''}
                      </span>
                    </label>
                  </li>
                ))}
            </ul>
            {registry.children.length === 0 && (
              <p className="text-sm text-slate-600">No subcategories configured.</p>
            )}
          </fieldset>
          <div aria-label="Selected product preview" className="min-w-0">
            <h3 className="text-sm font-semibold">Assignment preview</h3>
            <ul className="divide-y divide-slate-200">
              {products.map((product, index) => {
                const previous = readProductSubcategories(product, registry);
                const nextIds =
                  mode === 'append' && previous.status === 'valid'
                    ? [...new Set([...previous.subcategoryIds, ...ids])]
                    : ids;
                const names = nextIds.map(
                  (id) =>
                    registry.children.find((child) => child.id === id)?.name ??
                    'Invalid subcategory',
                );
                return (
                  <li key={`${product._id}-${index}`} className="min-w-0 break-words py-2 text-sm">
                    <span className="font-semibold">{String(product.name ?? product._id)}</span>
                    <p>
                      {registry.name}: {names.join(', ') || 'No subcategories'}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
      {validation && (
        <p role="alert" className="text-sm text-red-700">
          {validation}
        </p>
      )}
      {confirmation && (
        <div
          aria-label="Confirm product assignment"
          className="space-y-3 border-y border-brand-200 py-3"
        >
          <p className="break-words text-sm">
            Confirm {mode} for {products.length} products in {registry?.name}?
            {publish
              ? ' Publish all selected products after classification is confirmed.'
              : ' Drafts will not be published.'}
          </p>
          {!confirmationCurrent && (
            <p role="alert">
              Products or categories changed. Cancel and review the updated preview.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={locked || !confirmationCurrent || query.isFetching || Boolean(query.error)}
              onClick={() => void save()}
            >
              Confirm assignment
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              Cancel confirmation
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${buttonClass} bg-brand-700 text-white`}
          disabled={locked || !request || query.isFetching || Boolean(query.error)}
          onClick={() => setConfirmation(request)}
        >
          {publish ? 'Review classification and publish' : 'Review assignment'}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={pending || busy}
          onClick={() => {
            setConfirmation(null);
            if (!finished) {
              setSelected(null);
              setAppliedSuggestion(null);
              setMode('replace');
              setFamily(productFamilyForDoc(products[0] ?? {}) ?? 'headphones');
              setMessage('');
            }
            onCancel?.();
          }}
        >
          Cancel
        </button>
        {(finished || validation) && (
          <button
            type="button"
            className={buttonClass}
            disabled={pending || busy}
            onClick={() => void refreshProducts()}
          >
            Refresh products
          </button>
        )}
      </div>
      {pending && (
        <output className="block">
          {publish ? 'Classifying and publishing...' : 'Saving classification...'}
        </output>
      )}
      {message && <output className="block break-words text-sm">{message}</output>}
      {publicationResult && (
        <BatchUpdateFeedback
          result={publicationResult}
          names={Object.fromEntries(
            products.map((product) => [product._id, String(product.name ?? product._id)]),
          )}
          published
          onDismiss={() => setPublicationResult(null)}
        />
      )}
      {publicationResult && publicationResult.failures.length === 0 && (
        <button type="button" className={buttonClass} onClick={onSaved}>
          Done
        </button>
      )}
      {results.length > 0 && (
        <ul aria-label="Product assignment results" className="divide-y divide-slate-200">
          {results.map((item) => (
            <li key={item.productId} className="break-words py-2 text-sm">
              <span className="font-semibold">
                {String(
                  products.find((product) => product._id === item.productId)?.name ??
                    item.productId,
                )}
              </span>
              : {resultLabels[item.status]}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
