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
  getRecord,
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
  onUnresolved?: (snapshot: UnresolvedClassificationSnapshot) => void;
  onVerified?: (submittedIds: readonly string[]) => void;
  onSaved: () => void;
  onCancel?: () => void;
}

export interface UnresolvedClassificationSnapshot {
  command: CatalogClassificationAssignmentRequest;
  submittedIds: string[];
  confirmedPublishedIds: string[];
  unresolvedIds: string[];
  attentionIds: string[];
  issuesById: Record<string, string>;
}

export function unresolvedClassificationSnapshot(
  command: CatalogClassificationAssignmentRequest,
  assignmentResults: CatalogClassificationAssignmentResult['results'] | null,
  publication: BatchUpdateResult | null,
): UnresolvedClassificationSnapshot {
  const submittedIds = command.products.map((item) => item.productId);
  const confirmedPublishedIds = publication?.items.map((item) => item._id) ?? [];
  const assignmentById = new Map(assignmentResults?.map((item) => [item.productId, item.status]));
  const allAssignmentsSaved = submittedIds.every((id) => assignmentById.get(id) === 'saved');
  const unknownPublicationIds = new Set(
    publication?.failures
      .filter((failure) => failure.outcome !== 'rejected')
      .map((failure) => failure.id),
  );
  const rejectedPublicationIds = new Set(
    publication?.failures
      .filter((failure) => failure.outcome === 'rejected')
      .map((failure) => failure.id),
  );
  const unresolvedIds = submittedIds.filter((id) => {
    const status = assignmentById.get(id);
    return (
      !status ||
      status === 'unknown' ||
      status === 'notattempted' ||
      unknownPublicationIds.has(id) ||
      (command.includeSavedRevision === true && allAssignmentsSaved && publication === null)
    );
  });
  const attentionIds = submittedIds.filter((id) => {
    const status = assignmentById.get(id);
    return (
      rejectedPublicationIds.has(id) ||
      (status !== undefined &&
        status !== 'saved' &&
        status !== 'unknown' &&
        status !== 'notattempted') ||
      (status === 'saved' && command.includeSavedRevision === true && !allAssignmentsSaved)
    );
  });
  const issuesById: Record<string, string> = {};
  for (const result of assignmentResults ?? []) {
    if (result.status !== 'saved') issuesById[result.productId] = resultLabels[result.status];
  }
  for (const id of attentionIds) {
    if (!issuesById[id]) issuesById[id] = 'Assignment saved; publication blocked';
  }
  for (const failure of publication?.failures ?? []) issuesById[failure.id] = failure.message;
  return { command, submittedIds, confirmedPublishedIds, unresolvedIds, attentionIds, issuesById };
}

export function matchesSubmittedProducts(
  snapshot: UnresolvedClassificationSnapshot,
  beforeProducts: readonly CollectionDoc[],
  records: readonly CollectionDoc[],
): boolean {
  if (records.length !== snapshot.submittedIds.length) return false;
  const command = snapshot.command;
  const beforeById = new Map(beforeProducts.map((product) => [product._id, product]));
  const recordById = new Map(records.map((record) => [record._id, record]));
  const confirmedPublished = new Set(snapshot.confirmedPublishedIds);
  return snapshot.submittedIds.every((id) => {
    const before = beforeById.get(id);
    const record = recordById.get(id);
    if (!before || !record) return false;
    if (snapshot.unresolvedIds.includes(id) || snapshot.attentionIds.includes(id))
      return !confirmedPublished.has(id) || record.published === true;
    const actualIds = record.subcategoryIds;
    if (
      productFamilyForDoc(record) !== command.family ||
      !Array.isArray(actualIds) ||
      !actualIds.every((id) => typeof id === 'string')
    )
      return false;
    const previousIds = Array.isArray(before.subcategoryIds)
      ? before.subcategoryIds
      : productFamilyForDoc(before) === 'headphones' &&
          typeof before.category === 'string' &&
          before.category
        ? [`headphones-${before.category}`]
        : [];
    const expectedIds =
      command.operation === 'append'
        ? [...new Set([...previousIds, ...command.subcategoryIds])]
        : command.subcategoryIds;
    return (
      actualIds.length === expectedIds.length &&
      expectedIds.every((expectedId) => actualIds.includes(expectedId)) &&
      record.published === (confirmedPublished.has(record._id) ? true : before.published)
    );
  });
}

export function matchesVerifiedOutcome(
  snapshot: UnresolvedClassificationSnapshot,
  beforeProducts: readonly CollectionDoc[],
  records: readonly CollectionDoc[],
): boolean {
  if (snapshot.attentionIds.length > 0) return false;
  return matchesSubmittedProducts(
    {
      ...snapshot,
      unresolvedIds: [],
      confirmedPublishedIds:
        snapshot.command.includeSavedRevision === true
          ? snapshot.submittedIds
          : snapshot.confirmedPublishedIds,
    },
    beforeProducts,
    records,
  );
}

async function verifySubmittedProducts(
  snapshot: UnresolvedClassificationSnapshot,
  beforeProducts: readonly CollectionDoc[],
): Promise<boolean> {
  const records = await Promise.all(snapshot.submittedIds.map((id) => getRecord('products', id)));
  return matchesSubmittedProducts(snapshot, beforeProducts, records);
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
  onBusyChange,
  onUnresolved,
  onVerified,
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
  const [publish, setPublish] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [confirmation, setConfirmation] = useState<CatalogClassificationAssignmentRequest | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<'assigning' | 'publishing' | 'refreshing'>('assigning');
  const [showPublishingWait, setShowPublishingWait] = useState(false);
  const [finished, setFinished] = useState(false);
  const [message, setMessage] = useState('');
  const [submittedCommand, setSubmittedCommand] =
    useState<CatalogClassificationAssignmentRequest | null>(null);
  const [results, setResults] = useState<CatalogClassificationAssignmentResult['results'] | null>(
    null,
  );
  const [publicationResult, setPublicationResult] = useState<BatchUpdateResult | null>(null);
  const [showPublicationFeedback, setShowPublicationFeedback] = useState(true);
  const [readbackFailed, setReadbackFailed] = useState(false);
  const [readbackVerified, setReadbackVerified] = useState(false);
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
  const publicCount = products.filter((product) => product.published === true).length;
  const draftCount = products.filter((product) => product.published === false).length;
  const canPublish = draftCount > 0 && draftCount === products.length && !appliedSuggestion;
  const unresolvedSnapshot = submittedCommand
    ? unresolvedClassificationSnapshot(submittedCommand, results, publicationResult)
    : null;
  const needsVerification = Boolean(
    finished &&
      unresolvedSnapshot &&
      ((unresolvedSnapshot.unresolvedIds.length > 0 && !readbackVerified) ||
        unresolvedSnapshot.attentionIds.length > 0 ||
        readbackFailed),
  );
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
    confirmation !== null &&
    (!publish || canPublish) &&
    JSON.stringify(confirmation) === JSON.stringify(request);

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
    setSubmittedCommand(null);
    setResults(null);
    setPublicationResult(null);
    setReadbackVerified(false);
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
    setReadbackVerified(false);
    setStage('refreshing');
    setFinished(true);
    setConfirmation(null);
    busyCallback.current?.(true);
    try {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['list', 'products'] }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: ['catalog-taxonomy'] }, { throwOnError: true }),
      ]);
      const records =
        submittedCommand && unresolvedSnapshot
          ? await Promise.all(
              unresolvedSnapshot.submittedIds.map((id) => getRecord('products', id)),
            )
          : null;
      if (
        records &&
        unresolvedSnapshot &&
        !matchesSubmittedProducts(unresolvedSnapshot, products, records)
      )
        throw new Error('Product statuses do not match the submitted classification.');
      if (mounted.current) {
        setReadbackFailed(false);
        if (
          unresolvedSnapshot &&
          records &&
          matchesVerifiedOutcome(unresolvedSnapshot, products, records)
        ) {
          setReadbackVerified(true);
          onVerified?.(unresolvedSnapshot.submittedIds);
          setRefreshRequested(true);
          setMessage(
            unresolvedSnapshot.command.includeSavedRevision === true
              ? 'Current product statuses verified: selected products are published. No write was retried.'
              : 'Current product classifications verified. No write was retried.',
          );
        } else {
          setMessage('Product statuses refreshed. Inspect affected products before retrying.');
        }
      }
    } catch {
      if (mounted.current) {
        setReadbackFailed(true);
        setMessage(
          'Product statuses could not be verified. Confirmed write receipts remain available.',
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPending(false);
        busyCallback.current?.(false);
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
    const submitted = confirmation;
    inFlight.current = true;
    setPending(true);
    setStage('assigning');
    setShowPublishingWait(false);
    setReadbackFailed(false);
    setReadbackVerified(false);
    setSubmittedCommand(submitted);
    setResults(null);
    setPublicationResult(null);
    setShowPublicationFeedback(true);
    busyCallback.current?.(true);
    setConfirmation(null);
    let result: CatalogClassificationAssignmentResult;
    try {
      result = await mutation.mutateAsync(submitted);
    } catch {
      if (mounted.current) {
        setFinished(true);
        setMessage(
          'Assignment was not confirmed. Refresh products before trying again; some changes may have been saved.',
        );
        onUnresolved?.(unresolvedClassificationSnapshot(submitted, null, null));
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
            ? 'Classification saved.'
            : 'Classification saved. Drafts were not published.'
          : 'Review the product results and refresh before another assignment.',
    );
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    let publicationOutcome: BatchUpdateResult | null = null;
    try {
      if (publish && allSaved) {
        const publication = publishConfirmedClassification(submitted, result);
        if (publication) {
          setStage('publishing');
          waitTimer = setTimeout(() => {
            if (mounted.current) setShowPublishingWait(true);
          }, 250);
          const outcome = await publication;
          if (mounted.current) {
            publicationOutcome = outcome;
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
    } catch {
      if (mounted.current)
        setMessage('Publication could not be confirmed. Refresh product statuses before retrying.');
    } finally {
      clearTimeout(waitTimer);
      if (mounted.current) {
        setShowPublishingWait(false);
        setStage('refreshing');
      }
    }
    const snapshot = unresolvedClassificationSnapshot(
      submitted,
      result.results,
      publicationOutcome,
    );
    let readbackSucceeded = false;
    try {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['list', 'products'] }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: ['catalog-taxonomy'] }, { throwOnError: true }),
      ]);
      const verified = await verifySubmittedProducts(snapshot, products);
      if (!verified) throw new Error('Product statuses do not match the submitted classification.');
      readbackSucceeded = true;
    } catch {
      if (mounted.current) {
        setReadbackFailed(true);
        setMessage(
          'Product statuses could not be verified. Confirmed publication receipts remain available. Refresh statuses before closing.',
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setReadbackVerified(
          readbackSucceeded &&
            snapshot.unresolvedIds.length === 0 &&
            snapshot.attentionIds.length === 0,
        );
        if (
          !readbackSucceeded ||
          snapshot.unresolvedIds.length > 0 ||
          snapshot.attentionIds.length > 0
        )
          onUnresolved?.(snapshot);
        else onVerified?.(snapshot.submittedIds);
        setPending(false);
        busyCallback.current?.(false);
        if (allSaved && !publish && readbackSucceeded) onSaved();
      }
    }
  }

  function review(nextPublish: boolean) {
    if (!request || (nextPublish && !canPublish)) return;
    const { includeSavedRevision: _savedRevision, ...draftRequest } = request;
    setPublish(nextPublish);
    setConfirmation(nextPublish ? { ...draftRequest, includeSavedRevision: true } : draftRequest);
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
      <p className="text-sm text-slate-600">
        {publicCount} public / {draftCount} drafts
      </p>
      {publicCount > 0 && (
        <p className="text-sm text-amber-900">
          Saving classification on a published product may change storefront filters immediately.
        </p>
      )}
      {!canPublish && (
        <p className="text-sm text-slate-600">Select drafts separately to publish.</p>
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
              {publish ? 'Confirm save and publish' : 'Confirm save'}
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
          className={buttonClass}
          disabled={locked || !request || query.isFetching || Boolean(query.error)}
          onClick={() => review(false)}
        >
          Save classification
        </button>
        <button
          type="button"
          className={`${buttonClass} bg-brand-700 text-white`}
          disabled={locked || !request || !canPublish || query.isFetching || Boolean(query.error)}
          onClick={() => review(true)}
        >
          Save and publish
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={pending || busy || (needsVerification && (!onUnresolved || !onCancel))}
          onClick={() => {
            setConfirmation(null);
            if (needsVerification && unresolvedSnapshot) {
              onUnresolved?.(unresolvedSnapshot);
              onCancel?.();
              return;
            }
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
          {needsVerification && onUnresolved ? 'Check later' : 'Cancel'}
        </button>
        {(finished || validation) && (
          <button
            type="button"
            className={buttonClass}
            disabled={pending || busy}
            onClick={() => void refreshProducts()}
          >
            {readbackFailed || publicationResult ? 'Refresh statuses' : 'Refresh products'}
          </button>
        )}
      </div>
      {pending && (stage !== 'publishing' || showPublishingWait) && (
        <output className="block">
          {stage === 'assigning'
            ? 'Saving classification...'
            : stage === 'publishing'
              ? 'Publishing selected products...'
              : 'Checking product statuses...'}
        </output>
      )}
      {message && <output className="block break-words text-sm">{message}</output>}
      {publicationResult &&
        (publicationResult.failures.length === 0 || !readbackVerified) &&
        showPublicationFeedback && (
          <BatchUpdateFeedback
            result={publicationResult}
            names={Object.fromEntries(
              products.map((product) => [product._id, String(product.name ?? product._id)]),
            )}
            published
            onDismiss={() => setShowPublicationFeedback(false)}
          />
        )}
      {publicationResult &&
        (publicationResult.failures.length === 0 || !readbackVerified) &&
        !showPublicationFeedback && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => setShowPublicationFeedback(true)}
          >
            View publication receipts
          </button>
        )}
      {publicationResult && readbackVerified && publicationResult.failures.length > 0 && (
        <details className="border-t border-slate-200 pt-3 text-sm">
          <summary className="cursor-pointer font-medium">Original publication response</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {publicationResult.failures.map((failure) => (
              <li key={failure.id} className="break-words">
                {String(products.find((product) => product._id === failure.id)?.name ?? failure.id)}
                : {failure.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {publicationResult && readbackVerified && !pending && !readbackFailed && (
        <button type="button" className={buttonClass} onClick={onSaved}>
          Done
        </button>
      )}
      {results && results.length > 0 && (
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
