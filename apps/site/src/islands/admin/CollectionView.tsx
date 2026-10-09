import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type {
  CollectionDef,
  CollectionDoc,
  FieldDef,
  FilterModel,
  ProductFamily,
  SortClause,
} from '@vibelingan-channel/shared';
import {
  PRODUCT_FAMILY_OPTIONS,
  isProductFamily,
  productFamilyForDoc,
} from '@vibelingan-channel/shared';
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Select } from '../../components/form/Select.tsx';
import { BatchUpdateFeedback } from './BatchUpdateFeedback.tsx';
import { CatalogTaxonomyManager } from './CatalogTaxonomyManager.tsx';
import { ClassificationDialog } from './ClassificationDialog.tsx';
import { FileDownloadLink } from './FileDownloadLink.tsx';
import { FilterBuilder } from './FilterBuilder.tsx';
import { PageJump } from './PageJump.tsx';
import { PreviewModal } from './PreviewModal.tsx';
import {
  type UnresolvedClassificationSnapshot,
  matchesVerifiedOutcome,
} from './ProductClassificationEditor.tsx';
import { RecordForm } from './RecordForm.tsx';
import { productReviewCellValue } from './alibaba-source-review.ts';
import {
  DraftSavedError,
  batchRemoveRecords,
  batchUpdateRecords,
  createRecord,
  fetchProductReviewSummary,
  getRecord,
  imageUrl,
  listRecords,
  markProductReviewed,
  removeRecord,
  updateRecord,
} from './api.ts';
import {
  ADMIN_PRODUCT_FAMILY_LABELS,
  type AdminProductFamily,
  adminProductFamilyFromSearch,
  adminProductFamilySearch,
  adminSubcategoryFromSearch,
  productFamilyListArgs,
} from './product-family-tabs.ts';
import { adminThumbnail, productThumbnailSource } from './product-thumbnail.ts';
import { reviewLabel, splitForBatchPublish } from './review-reason.ts';
import type { DashboardSection } from './sections.ts';
import {
  savedProductSubcategories,
  savedSubcategoriesText,
  subcategoryFilterOptions,
  taxonomyQuery,
} from './taxonomy-ui-state.ts';

const PAGE_SIZE = 20;

export interface ProductClassificationReview {
  snapshot: UnresolvedClassificationSnapshot;
  names: Record<string, string>;
  beforeProducts: readonly CollectionDoc[];
}

interface Props {
  collection: CollectionDef;
  section: DashboardSection;
  role: string;
  productSelection: Record<string, boolean>;
  onProductSelectionChange: Dispatch<SetStateAction<Record<string, boolean>>>;
  productReview: ProductClassificationReview | null;
  onProductReviewChange: Dispatch<SetStateAction<ProductClassificationReview | null>>;
}

export function CollectionView({
  collection,
  section,
  role,
  productSelection,
  onProductSelectionChange,
  productReview,
  onProductReviewChange,
}: Props) {
  const queryClient = useQueryClient();
  const isProducts = collection.name === 'products';
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filter, setFilter] = useState<FilterModel | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [localRowSelection, setLocalRowSelection] = useState<Record<string, boolean>>({});
  const rowSelection = isProducts ? productSelection : localRowSelection;
  const setRowSelection = isProducts ? onProductSelectionChange : setLocalRowSelection;
  const currentSelectionRef = useRef(rowSelection);
  currentSelectionRef.current = rowSelection;
  const [editing, setEditing] = useState<CollectionDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<CollectionDoc | null>(null);
  // Batch Publish where every selected product was skipped: no request, just the notice.
  const [skippedOnly, setSkippedOnly] = useState<{
    skipped: string[];
    names: Record<string, string>;
  } | null>(null);
  // A publish that kept "Changed": some supplier change still needs a decision (DEC-19).
  const [stillFlagged, setStillFlagged] = useState<string | null>(null);
  // "See changes" from the edit form: read-only, so nothing changes under the form.
  const [changesPreview, setChangesPreview] = useState<CollectionDoc | null>(null);
  const [classifying, setClassifying] = useState<{
    products: CollectionDoc[];
    publishOnSave: boolean;
  } | null>(null);
  const classificationReview = isProducts ? productReview : null;
  const classificationBlocked = classificationReview !== null;
  const reviewIds = classificationReview
    ? [
        ...new Set([
          ...classificationReview.snapshot.unresolvedIds,
          ...classificationReview.snapshot.attentionIds,
        ]),
      ]
    : [];
  const setClassificationReview = onProductReviewChange;
  const currentReviewRef = useRef(classificationReview);
  currentReviewRef.current = classificationReview;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [reviewRefreshing, setReviewRefreshing] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');
  const reviewAction = useRef<HTMLButtonElement>(null);
  const [taxonomyOpened, setTaxonomyOpened] = useState(false);

  const isCatalog = section.catalog === true;
  const canReviewAlibabaProducts = isProducts && role === 'admin';
  // Registry reads are admin-only on the server, so only admins get subcategory names and filters.
  const canReadSubcategories = isProducts && role === 'admin';
  const [productFamily, setProductFamily] = useState<AdminProductFamily>(() =>
    isProducts && typeof window !== 'undefined'
      ? adminProductFamilyFromSearch(window.location.search)
      : null,
  );
  const [subcategoryId, setSubcategoryId] = useState<string | null>(() =>
    canReadSubcategories && typeof window !== 'undefined'
      ? adminSubcategoryFromSearch(window.location.search)
      : null,
  );
  const isUsers = collection.name === 'users';
  const inlineEdit = useMemo(() => new Set(section.inlineEdit ?? []), [section.inlineEdit]);
  const singular = section.label.replace(/s$/, '');

  const sortClauses: SortClause[] = useMemo(
    () => sorting.map((s) => ({ field: s.id, dir: s.desc ? 'desc' : 'asc' })),
    [sorting],
  );

  const queryKey = [
    'list',
    collection.name,
    productFamily,
    subcategoryId,
    page,
    search,
    filter,
    sortClauses,
  ] as const;
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () =>
      listRecords(
        productFamilyListArgs(
          {
            collection: collection.name,
            page,
            pageSize: PAGE_SIZE,
            search,
            ...(filter ? { filter } : {}),
            ...(sortClauses.length > 0 ? { sort: sortClauses } : {}),
          },
          productFamily,
          subcategoryId,
        ),
      ),
  });
  const { data: reviewSummary } = useQuery({
    queryKey: ['product-review-summary'],
    queryFn: fetchProductReviewSummary,
    enabled: canReviewAlibabaProducts,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const { data: unclassifiedSummary } = useQuery({
    queryKey: ['list', 'products', 'unclassified-count'],
    queryFn: () =>
      listRecords({ collection: 'products', needsClassification: true, page: 1, pageSize: 1 }),
    enabled: isProducts,
    staleTime: 15_000,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['list', collection.name] });
    if (isProducts) queryClient.invalidateQueries({ queryKey: ['product-review-summary'] });
  }

  function clearSelection() {
    setRowSelection({});
  }

  async function refreshClassificationStatuses() {
    if (!classificationReview || reviewRefreshing) return;
    const current = classificationReview;
    const selectionAtRefresh = rowSelection;
    setReviewRefreshing(true);
    setReviewMessage('');
    try {
      await queryClient.invalidateQueries(
        { queryKey: ['list', 'products'] },
        { throwOnError: true },
      );
      if (!mounted.current || currentReviewRef.current !== current) return;
      const products = await Promise.all(
        current.snapshot.submittedIds.map((id) => getRecord('products', id)),
      );
      if (!mounted.current || currentReviewRef.current !== current) return;
      if (matchesVerifiedOutcome(current.snapshot, current.beforeProducts, products)) {
        setClassificationReview(null);
        if (currentSelectionRef.current === selectionAtRefresh) clearSelection();
      } else {
        setReviewMessage('Statuses refreshed. Inspect affected products before retrying.');
      }
    } catch {
      if (mounted.current && currentReviewRef.current === current)
        setReviewMessage('Product status refresh failed. Confirmed receipts remain available.');
    } finally {
      if (mounted.current) setReviewRefreshing(false);
    }
  }

  const createMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) => createRecord(collection.name, values),
    onSuccess: () => {
      setCreating(false);
      invalidate();
    },
    onError: (error) => {
      // The draft exists: close the form so a retry cannot create it twice; the
      // reason it was not published shows above the list.
      if (error instanceof DraftSavedError) {
        setCreating(false);
        invalidate();
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; values: Record<string, unknown> }) =>
      updateRecord(collection.name, vars.id, vars.values),
    onSuccess: (saved) => {
      setEditing(null);
      setStillFlagged(
        saved.published === true && ['Changed', 'Removed'].includes(String(reviewLabel(saved)))
          ? String(saved.name || saved._id)
          : null,
      );
      invalidate();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeRecord(collection.name, id),
    onSuccess: invalidate,
  });

  const batchUpdateMutation = useMutation({
    mutationFn: (vars: {
      ids: string[];
      values: Record<string, unknown>;
      names: Record<string, string>;
      skipped?: string[];
    }) => batchUpdateRecords(collection.name, vars.ids, vars.values),
    onSuccess: (result) => {
      const completed = new Set(result.items.map((item) => item._id));
      setRowSelection((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !completed.has(id))),
      );
      invalidate();
    },
  });

  const batchRemoveMutation = useMutation({
    mutationFn: (ids: string[]) => batchRemoveRecords(collection.name, ids),
    onSuccess: () => {
      clearSelection();
      invalidate();
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (productId: string) => markProductReviewed(productId),
    onSuccess: (updated) => {
      setPreviewing(updated);
      invalidate();
    },
  });
  const unpublishFromReviewMutation = useMutation({
    mutationFn: (productId: string) => updateRecord('products', productId, { published: false }),
    onSuccess: (updated) => {
      setPreviewing(updated);
      invalidate();
    },
  });
  const recordWritePending =
    updateMutation.isPending ||
    removeMutation.isPending ||
    batchUpdateMutation.isPending ||
    batchRemoveMutation.isPending;

  const visibleMutationError =
    (!creating && createMutation.error instanceof DraftSavedError && createMutation.error) ||
    batchUpdateMutation.error ||
    (!editing && updateMutation.error) ||
    removeMutation.error ||
    batchRemoveMutation.error;

  function patch(id: string, values: Record<string, unknown>) {
    updateMutation.mutate({ id, values });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: selection resets only when the visible scope changes
  useEffect(() => {
    setRowSelection(
      classificationReview
        ? Object.fromEntries(classificationReview.snapshot.submittedIds.map((id) => [id, true]))
        : {},
    );
  }, [search, filter, page, productFamily, subcategoryId]);

  useEffect(() => {
    if (!classifying && classificationReview && document.activeElement === document.body)
      reviewAction.current?.focus({ preventScroll: true });
  }, [classifying, classificationReview]);

  function pushProductScope(nextFamily: AdminProductFamily, nextSubcategory: string | null) {
    if (typeof window === 'undefined') return;
    const nextUrl = `${window.location.pathname}${adminProductFamilySearch(window.location.search, nextFamily, nextSubcategory)}${window.location.hash}`;
    window.history.pushState(null, '', nextUrl);
  }

  function changeProductFamily(next: AdminProductFamily) {
    setProductFamily(next);
    setSubcategoryId(null);
    setPage(1);
    clearSelection();
    pushProductScope(next, null);
  }

  function changeSubcategory(next: string | null) {
    setSubcategoryId(next);
    setPage(1);
    clearSelection();
    pushProductScope(productFamily, next);
  }

  useEffect(() => {
    if (!isProducts) return;
    const recoverFamily = () => {
      setProductFamily(adminProductFamilyFromSearch(window.location.search));
      setSubcategoryId(
        canReadSubcategories ? adminSubcategoryFromSearch(window.location.search) : null,
      );
      setPage(1);
      setRowSelection({});
    };
    window.addEventListener('popstate', recoverFamily);
    return () => window.removeEventListener('popstate', recoverFamily);
  }, [isProducts, canReadSubcategories, setRowSelection]);

  const tableFields = useMemo(() => {
    const visible = collection.fields.filter(
      (field) => !field.hideInTable && !(isCatalog && field.name === 'published'),
    );
    // Product rows are an operator review queue, not a raw dump of the legacy
    // product document. Fields that Alibaba does not supply (slug, series,
    // website prices) stay editable in the form but do not become columns full
    // of misleading blanks. The source evidence columns below replace them.
    // The legacy scalar `category` is not shown: saved subcategory names come
    // from `subcategoryIds` through the registry (admin column below).
    return isProducts
      ? visible.filter((field) => ['name', 'productFamily'].includes(field.name))
      : visible;
  }, [collection.fields, isCatalog, isProducts]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = useMemo(() => data?.items ?? [], [data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: handler closures are stable for this view
  const columns = useMemo<ColumnDef<CollectionDoc>[]>(() => {
    const cols: ColumnDef<CollectionDoc>[] = [];

    cols.push({
      id: 'select',
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllRowsSelected()}
          indeterminate={table.getIsSomeRowsSelected()}
          onChange={table.getToggleAllRowsSelectedHandler()}
          ariaLabel="Select all rows"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
          ariaLabel="Select row"
        />
      ),
    });

    if (isCatalog) {
      cols.push({
        id: 'image',
        header: 'Image',
        enableSorting: false,
        cell: ({ row }) => <ProductThumbnail doc={row.original} />,
      });
    }

    for (const field of tableFields) {
      cols.push({
        id: field.name,
        accessorKey: field.name,
        header:
          isProducts && field.name === 'productFamily' ? 'Website main category' : field.label,
        cell: ({ row }) => {
          const doc = row.original;
          if (isProducts && field.name === 'productFamily') {
            const family = productFamilyForDoc(doc);
            return (
              <TextCell
                field={field.name}
                value={family ? ADMIN_PRODUCT_FAMILY_LABELS[family] : 'Needs classification'}
              />
            );
          }
          if (inlineEdit.has(field.name) && field.type === 'select') {
            return (
              <InlineSelect
                field={field}
                value={doc[field.name]}
                onChange={(v) => patch(doc._id, { [field.name]: v })}
              />
            );
          }
          if (field.type === 'file') {
            return <FileDownloadLink id={doc[field.name]} name={doc.drawingName} />;
          }
          return <TextCell field={field.name} value={doc[field.name]} />;
        },
      });
    }

    if (canReadSubcategories) {
      cols.push({
        id: 'websiteSubcategories',
        header: 'Website subcategories',
        enableSorting: false,
        cell: ({ row }) => <SavedSubcategoriesCell doc={row.original} />,
      });
    }

    if (isProducts) {
      for (const sourceColumn of [
        { id: 'reviewIdentity', label: 'SKU / Source ID', cell: 'identity' },
        { id: 'reviewSourceCategory', label: 'Source Category', cell: 'category' },
        { id: 'reviewModel', label: 'Model', cell: 'model' },
        { id: 'reviewVariants', label: 'Variants', cell: 'variants' },
        { id: 'reviewMoq', label: 'MOQ', cell: 'moq' },
        { id: 'reviewPricing', label: 'Pricing', cell: 'pricing' },
      ] as const) {
        cols.push({
          id: sourceColumn.id,
          header: sourceColumn.label,
          enableSorting: false,
          cell: ({ row }) => (
            <TextCell
              field={sourceColumn.id}
              value={productReviewCellValue(row.original, sourceColumn.cell)}
            />
          ),
        });
      }
    }

    if (isCatalog) {
      cols.push({
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <PublishToggle
            published={row.original.published === true}
            busy={recordWritePending}
            onToggle={() =>
              // Publishing a flagged product goes through its review in Edit (DEC-19).
              row.original.published !== true &&
              ['Changed', 'Removed'].includes(String(reviewLabel(row.original)))
                ? setEditing(row.original)
                : patch(row.original._id, { published: !(row.original.published === true) })
            }
          />
        ),
      });
    }

    cols.push({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const doc = row.original;
        return (
          <div className="whitespace-nowrap text-right">
            {isProducts && role === 'admin' && (
              <button
                type="button"
                disabled={classificationBlocked || recordWritePending}
                title={
                  classificationBlocked
                    ? 'Resolve the pending classification result before starting another'
                    : undefined
                }
                onClick={() => setClassifying({ products: [doc], publishOnSave: false })}
                className="mr-3 min-h-11 text-sm font-medium text-brand-700 disabled:opacity-50"
              >
                Classify
              </button>
            )}
            {isCatalog && (
              <button
                type="button"
                onClick={() => setPreviewing(doc)}
                className="text-sm font-medium text-brand-700 hover:text-brand-900"
              >
                Preview
              </button>
            )}
            <button
              type="button"
              disabled={recordWritePending}
              onClick={() => setEditing(doc)}
              className="ml-3 text-sm font-medium text-slate-700 hover:text-slate-900 disabled:opacity-50"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={recordWritePending || (isProducts && doc.archived === true)}
              onClick={() => {
                if (isProducts) {
                  if (confirm('Archive this product? It will no longer be published.'))
                    patch(doc._id, { archived: true, published: false });
                } else if (confirm('Delete this record?')) removeMutation.mutate(doc._id);
              }}
              className="ml-3 text-sm font-medium text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              {isProducts ? 'Archive' : 'Delete'}
            </button>
          </div>
        );
      },
    });

    return cols;
  }, [
    tableFields,
    isCatalog,
    isProducts,
    canReadSubcategories,
    role,
    inlineEdit,
    classificationBlocked,
    recordWritePending,
  ]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection },
    getRowId: (row) => row._id,
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    manualSorting: true,
    manualPagination: true,
    pageCount,
    getCoreRowModel: getCoreRowModel(),
    enableRowSelection: true,
  });

  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original._id);
  const colCount = columns.length;

  return (
    <div className="min-w-0 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{section.label}</h1>
          {collection.description && (
            <p className="mt-1 text-sm text-slate-500">{collection.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            createMutation.reset();
            setCreating(true);
          }}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          New {singular}
        </button>
      </header>

      {isProducts && (
        <div className="mt-6 border-b border-slate-200 pb-3">
          <fieldset className="hidden min-w-0 flex-wrap gap-1 xl:flex">
            <legend className="sr-only">Product family</legend>
            <ProductFamilyTab
              label="All products"
              value={null}
              selected={productFamily === null}
              pendingCount={reviewSummary?.pendingTotal ?? 0}
              onSelect={changeProductFamily}
            />
            <ProductFamilyTab
              label={`Needs classification${unclassifiedSummary ? ` (${unclassifiedSummary.total})` : ''}`}
              value="unclassified"
              selected={productFamily === 'unclassified'}
              pendingCount={0}
              onSelect={changeProductFamily}
            />
            {PRODUCT_FAMILY_OPTIONS.map((value) => (
              <ProductFamilyTab
                key={value}
                label={productFamilyLabel(value)}
                value={value}
                selected={productFamily === value}
                pendingCount={reviewSummary?.byFamily[value] ?? 0}
                onSelect={changeProductFamily}
              />
            ))}
          </fieldset>
          <Select
            ariaLabel="Product family"
            value={productFamily ?? ''}
            placeholder={`All products${(reviewSummary?.pendingTotal ?? 0) > 0 ? ' • Needs review' : ''}`}
            options={[
              {
                value: 'unclassified',
                label: `Needs classification${unclassifiedSummary ? ` (${unclassifiedSummary.total})` : ''}`,
              },
              ...PRODUCT_FAMILY_OPTIONS.map((value) => ({
                value,
                label: `${productFamilyLabel(value)}${(reviewSummary?.byFamily[value] ?? 0) > 0 ? ' • Needs review' : ''}`,
              })),
            ]}
            className="block xl:hidden"
            triggerClassName="font-medium text-slate-800"
            onChange={(value) =>
              changeProductFamily(isProductFamily(value) || value === 'unclassified' ? value : null)
            }
          />
          {productFamily === 'unclassified' && (
            <p className="mt-3 text-sm text-slate-600">
              These products have no website category. Their source categories are preserved. Open a
              product to assign its Product Family; saving a category does not publish it.
              Source-wide rules are managed in Import Categories and do not backfill existing
              products automatically.
            </p>
          )}
          {canReadSubcategories && isProductFamily(productFamily) && (
            <SubcategoryFilter
              key={productFamily}
              family={productFamily}
              value={subcategoryId}
              onChange={changeSubcategory}
            />
          )}
        </div>
      )}

      {isProducts && role === 'admin' && (
        <details
          className="mt-4 border-y border-slate-200 py-3"
          onToggle={(event) => {
            if (event.currentTarget.open) setTaxonomyOpened(true);
          }}
        >
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold">
            Manage website categories
          </summary>
          {taxonomyOpened && <CatalogTaxonomyManager />}
        </details>
      )}
      {classificationReview && (
        <div
          role="alert"
          className="mt-4 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">
            {classificationReview.snapshot.unresolvedIds.length > 0
              ? 'Classification result not confirmed for:'
              : classificationReview.snapshot.attentionIds.length > 0
                ? 'Classification needs attention for:'
                : 'Product status refresh failed for:'}
          </p>
          <p className="mt-1 break-words">
            {(reviewIds.length > 0 ? reviewIds : classificationReview.snapshot.submittedIds)
              .map((id) => classificationReview.names[id] ?? id)
              .join(', ')}
          </p>
          <p className="mt-1">
            {classificationReview.snapshot.confirmedPublishedIds.length} confirmed published;{' '}
            {classificationReview.snapshot.unresolvedIds.length} unresolved;{' '}
            {classificationReview.snapshot.attentionIds.length} need attention. Check product
            statuses before retrying.
          </p>
          {classificationReview.snapshot.unresolvedIds.length > 0 && (
            <ul aria-label="Products to verify" className="mt-2 list-disc space-y-1 pl-5">
              {classificationReview.snapshot.unresolvedIds.map((id) => (
                <li key={id} className="break-words">
                  {classificationReview.names[id] ?? id}:{' '}
                  {classificationReview.snapshot.issuesById[id] ??
                    'Result not confirmed; inspect before retrying.'}
                </li>
              ))}
            </ul>
          )}
          {classificationReview.snapshot.attentionIds.length > 0 && (
            <ul aria-label="Products needing attention" className="mt-2 list-disc space-y-1 pl-5">
              {classificationReview.snapshot.attentionIds.map((id) => (
                <li key={id} className="break-words">
                  {classificationReview.names[id] ?? id}:{' '}
                  {classificationReview.snapshot.issuesById[id] ?? 'Review product status'}
                </li>
              ))}
            </ul>
          )}
          {reviewMessage && <p className="mt-1">{reviewMessage}</p>}
          <button
            type="button"
            disabled={reviewRefreshing}
            className="mt-2 mr-4 min-h-11 text-sm font-semibold underline disabled:opacity-50"
            onClick={() => void refreshClassificationStatuses()}
          >
            {reviewRefreshing ? 'Refreshing statuses...' : 'Refresh statuses'}
          </button>
          <button
            type="button"
            ref={reviewAction}
            className="mt-2 min-h-11 text-sm font-semibold underline"
            onClick={() => {
              clearSelection();
              setClassificationReview(null);
              setReviewMessage('');
            }}
          >
            Clear selection and reminder
          </button>
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <form
          method="get"
          className="flex min-w-0 flex-1 gap-2 sm:flex-initial"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(searchInput.trim());
          }}
        >
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={`Search ${collection.searchableFields.join(', ')}…`}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 sm:w-72"
          />
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Search
          </button>
        </form>
        <FilterBuilder
          collection={collection}
          applied={filter}
          onApply={(next) => {
            setPage(1);
            setFilter(next);
          }}
        />
      </div>

      {selectedIds.length > 0 && (
        <BatchBar
          count={selectedIds.length}
          isCatalog={isCatalog}
          isUsers={isUsers}
          canClassify={isProducts && role === 'admin'}
          classifyBlocked={classificationBlocked}
          collection={collection}
          busy={recordWritePending}
          onClear={() => {
            clearSelection();
          }}
          onClassify={() =>
            setClassifying({
              products: rows.filter((row) => selectedIds.includes(row._id)),
              publishOnSave: true,
            })
          }
          onSetValues={(values) => {
            const names = Object.fromEntries(
              rows.map((row) => [row._id, String(row.name ?? row._id)]),
            );
            const docs = rows.filter((row) => selectedIds.includes(row._id));
            setSkippedOnly(null);
            if (isProducts && values.published === true) {
              // Products with Alibaba changes are reviewed one by one (DEC-19).
              const [flagged, others] = splitForBatchPublish(docs);
              const skipped = flagged.map((row) => row._id);
              if (others.length === 0) {
                setSkippedOnly({ skipped, names });
                return;
              }
              batchUpdateMutation.mutate({
                ids: others.map((row) => row._id),
                values,
                names,
                ...(skipped.length ? { skipped } : {}),
              });
              return;
            }
            batchUpdateMutation.mutate({ ids: selectedIds, values, names });
          }}
          onDelete={() => {
            if (isProducts) {
              if (
                confirm(`Archive ${selectedIds.length} products? They will no longer be published.`)
              )
                batchUpdateMutation.mutate({
                  ids: selectedIds,
                  values: { archived: true, published: false },
                  names: Object.fromEntries(
                    rows.map((row) => [row._id, String(row.name ?? row._id)]),
                  ),
                });
            } else if (confirm(`Delete ${selectedIds.length} record(s)?`)) {
              batchRemoveMutation.mutate(selectedIds);
            }
          }}
        />
      )}

      {skippedOnly && (
        <BatchUpdateFeedback
          result={{ updated: 0, items: [], failures: [] }}
          names={skippedOnly.names}
          published
          skipped={skippedOnly.skipped}
          onDismiss={() => setSkippedOnly(null)}
        />
      )}

      {batchUpdateMutation.isPending && (
        <output className="mt-4 block text-sm text-slate-600">
          Updating selected records. Please keep this page open.
        </output>
      )}
      {!batchUpdateMutation.isPending && batchUpdateMutation.data && (
        <BatchUpdateFeedback
          result={batchUpdateMutation.data}
          names={batchUpdateMutation.variables?.names ?? {}}
          skipped={batchUpdateMutation.variables?.skipped ?? []}
          published={
            typeof batchUpdateMutation.variables?.values.published === 'boolean'
              ? batchUpdateMutation.variables.values.published
              : undefined
          }
          onDismiss={() => batchUpdateMutation.reset()}
        />
      )}
      {stillFlagged && (
        <output
          data-still-flagged
          className="mt-4 block rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p>
            Saved “{stillFlagged}”. It stays flagged Changed until every supplier change has a
            decision. Open Edit to decide.
          </p>
          <button
            type="button"
            className="mt-2 min-h-11 underline"
            onClick={() => setStillFlagged(null)}
          >
            Dismiss
          </button>
        </output>
      )}
      {visibleMutationError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          <p>{visibleMutationError.message}</p>
          <p className="mt-2">
            Open Edit to resolve validation issues. If the request was interrupted, refresh the
            status before retrying.
          </p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => {
              createMutation.reset();
              batchUpdateMutation.reset();
              updateMutation.reset();
              removeMutation.reset();
              batchRemoveMutation.reset();
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <div
        className="mt-4 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white"
        style={{ contain: 'paint' }}
      >
        <table className="w-full min-w-max text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sortable = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th key={header.id} className="px-4 py-3 font-medium">
                      {sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 font-medium uppercase tracking-wide hover:text-slate-900"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon dir={sorted === false ? null : sorted} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-red-600">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading &&
              !error &&
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={row.getIsSelected() ? 'bg-brand-50' : 'hover:bg-slate-50'}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-slate-700">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            {data && rows.length === 0 && !isLoading && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-slate-400">
                  No records.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>
          {total} record{total === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            {page} / {pageCount}
          </span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
          {pageCount > 1 && <PageJump page={page} pageCount={pageCount} onJump={setPage} />}
        </div>
      </div>

      {classifying && (
        <ClassificationDialog
          products={classifying.products}
          publishOnSave={classifying.publishOnSave}
          onClose={() => setClassifying(null)}
          onUnresolved={(snapshot) => {
            setReviewMessage('');
            setClassificationReview({
              snapshot,
              beforeProducts: classifying.products,
              names: Object.fromEntries(
                classifying.products.map((product) => [
                  product._id,
                  String(product.name ?? product._id),
                ]),
              ),
            });
            setRowSelection((current) => ({
              ...current,
              ...Object.fromEntries(snapshot.submittedIds.map((id) => [id, true])),
            }));
          }}
          onVerified={(ids) => {
            setReviewMessage('');
            setClassificationReview((current) =>
              current &&
              current.snapshot.submittedIds.length === ids.length &&
              ids.every((id) => current.snapshot.submittedIds.includes(id))
                ? null
                : current,
            );
          }}
          onSaved={() => {
            setClassifying(null);
            clearSelection();
            invalidate();
          }}
        />
      )}
      {creating && (
        <RecordForm
          collection={collection}
          title={`New ${singular}`}
          {...(isProductFamily(productFamily) ? { defaults: { productFamily } } : {})}
          submitting={createMutation.isPending}
          error={createMutation.error as Error | null}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => createMutation.mutate(values)}
        />
      )}

      {editing && (
        <RecordForm
          collection={collection}
          title={`Edit ${singular}`}
          initial={editing}
          showSavedClassification={canReadSubcategories}
          submitting={updateMutation.isPending}
          error={updateMutation.error as Error | null}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => updateMutation.mutate({ id: editing._id, values })}
          onSeeChanges={() => setChangesPreview(editing)}
          canReviewSupplier={role === 'admin'}
          {...(role !== 'admin' && ['Changed', 'Removed'].includes(String(reviewLabel(editing)))
            ? {
                readOnlyReason:
                  'This product has Alibaba changes waiting for an admin’s review. Ask an admin to review it.',
              }
            : {})}
        />
      )}

      {previewing && (
        <PreviewModal
          doc={previewing}
          canMarkReviewed={canReviewAlibabaProducts}
          reviewBusy={reviewMutation.isPending || unpublishFromReviewMutation.isPending}
          reviewError={(reviewMutation.error ?? unpublishFromReviewMutation.error) as Error | null}
          onMarkReviewed={() => reviewMutation.mutate(previewing._id)}
          // Supplier changes are reviewed side by side in the edit form (DEC-19).
          onReviewChanges={() => {
            setEditing(previewing);
            setPreviewing(null);
          }}
          onUnpublish={() => unpublishFromReviewMutation.mutate(previewing._id)}
          onClose={() => setPreviewing(null)}
          onEdit={() => {
            setEditing(previewing);
            setPreviewing(null);
          }}
        />
      )}

      {changesPreview && (
        <PreviewModal
          doc={changesPreview}
          // The supplier preview and the live-page link, without any action.
          canMarkReviewed={canReviewAlibabaProducts}
          onClose={() => setChangesPreview(null)}
          onEdit={() => setChangesPreview(null)}
        />
      )}
    </div>
  );
}

function productFamilyLabel(productFamily: ProductFamily): string {
  return ADMIN_PRODUCT_FAMILY_LABELS[productFamily];
}

/** Read-only: rows show what the website uses; nothing here writes product data. */
function SavedSubcategoriesCell({ doc }: { doc: CollectionDoc }) {
  const family = productFamilyForDoc(doc);
  const registry = useQuery({
    ...taxonomyQuery(family ?? 'headphones'),
    enabled: family !== null,
  });
  if (!family) return <TextCell field="websiteSubcategories" value="" />;
  if (registry.error) {
    return (
      <span data-subcategory-state="error" className="text-sm text-red-700">
        Unavailable.{' '}
        <button
          type="button"
          onClick={() => void registry.refetch()}
          className="min-h-8 font-medium underline"
        >
          Retry subcategories
        </button>
      </span>
    );
  }
  if (!registry.data) {
    return (
      <span data-subcategory-state="loading" className="text-slate-400">
        Loading…
      </span>
    );
  }
  const saved = savedProductSubcategories(doc, registry.data);
  return (
    <span
      data-subcategory-state={saved.kind}
      className={saved.kind === 'invalid' ? 'text-amber-800' : undefined}
    >
      <TextCell field="websiteSubcategories" value={savedSubcategoriesText(saved)} />
    </span>
  );
}

function SubcategoryFilter({
  family,
  value,
  onChange,
}: {
  family: ProductFamily;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const registry = useQuery(taxonomyQuery(family));
  const label = productFamilyLabel(family);
  if (registry.error) {
    return (
      <div role="alert" className="mt-3 text-sm text-red-700">
        {label} subcategories could not be loaded.{' '}
        <button
          type="button"
          onClick={() => void registry.refetch()}
          className="min-h-11 font-medium underline"
        >
          Retry subcategories
        </button>
      </div>
    );
  }
  if (!registry.data) {
    return (
      <output className="mt-3 block text-sm text-slate-500">Loading {label} subcategories…</output>
    );
  }
  const options = subcategoryFilterOptions(registry.data);
  const unknown = value !== null && !options.some((option) => option.value === value);
  return (
    <div className="mt-3 space-y-2">
      {options.length === 0 ? (
        <p className="text-sm text-slate-600">No subcategories are configured for {label}.</p>
      ) : (
        <Select
          label="Website subcategory"
          value={unknown ? '' : (value ?? '')}
          placeholder="All subcategories"
          options={options}
          className="w-full sm:w-80"
          triggerClassName="mt-1"
          onChange={(next) => onChange(next || null)}
        />
      )}
      {unknown && (
        <p role="alert" className="text-sm text-amber-800">
          The selected subcategory does not belong to {label}.{' '}
          <button
            type="button"
            onClick={() => onChange(null)}
            className="min-h-11 font-medium underline"
          >
            Show all {label} products
          </button>
        </p>
      )}
    </div>
  );
}

export function ProductFamilyTab({
  label,
  value,
  selected,
  pendingCount,
  onSelect,
}: {
  label: string;
  value: AdminProductFamily;
  selected: boolean;
  pendingCount: number;
  onSelect: (value: AdminProductFamily) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(value)}
      className={`min-h-11 shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition ${
        selected
          ? 'bg-slate-900 text-white'
          : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
      }`}
    >
      <span className="inline-flex items-center gap-2">
        {label}
        {pendingCount > 0 && (
          <span
            aria-label={`${pendingCount} product${pendingCount === 1 ? '' : 's'} to review`}
            title={`${pendingCount} product${pendingCount === 1 ? '' : 's'} to review`}
            className={`h-2 w-2 rounded-full ${selected ? 'bg-amber-300' : 'bg-amber-500'}`}
          />
        )}
      </span>
    </button>
  );
}

function BatchBar({
  count,
  isCatalog,
  isUsers,
  canClassify,
  classifyBlocked,
  collection,
  busy,
  onClear,
  onClassify,
  onSetValues,
  onDelete,
}: {
  count: number;
  isCatalog: boolean;
  isUsers: boolean;
  canClassify: boolean;
  classifyBlocked: boolean;
  collection: CollectionDef;
  busy: boolean;
  onClear: () => void;
  onClassify: () => void;
  onSetValues: (values: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const roleField = collection.fields.find((f) => f.name === 'role');
  const statusField = collection.fields.find((f) => f.name === 'status');
  const compactActions = collection.name === 'products';

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
      <span className="text-sm font-semibold text-brand-900">{count} selected</span>

      {isCatalog && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetValues({ published: true })}
            className={`${compactActions ? 'hidden xl:inline-flex' : ''} rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50`}
          >
            Publish
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetValues({ published: false })}
            className={`${compactActions ? 'hidden xl:inline-flex' : ''} rounded-lg bg-slate-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50`}
          >
            Disable
          </button>
        </>
      )}

      {isUsers && roleField && (
        <BatchSelect
          label="Set role"
          field={roleField}
          disabled={busy}
          onPick={(value) => onSetValues({ role: value })}
        />
      )}
      {canClassify && (
        <button
          type="button"
          disabled={busy || count > 20 || classifyBlocked}
          title={
            classifyBlocked
              ? 'Resolve the pending classification result before starting another'
              : undefined
          }
          onClick={onClassify}
          className="min-h-11 rounded-lg border border-brand-300 bg-white px-4 text-sm font-semibold text-brand-700 disabled:opacity-50"
        >
          Assign category
        </button>
      )}
      {isUsers && statusField && (
        <BatchSelect
          label="Set status"
          field={statusField}
          disabled={busy}
          onPick={(value) => onSetValues({ status: value })}
        />
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        className={`${compactActions ? 'hidden xl:inline-flex' : ''} rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50`}
      >
        {compactActions ? 'Archive' : 'Delete'}
      </button>

      {compactActions && (
        <details className="relative xl:hidden">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700">
            Actions
          </summary>
          <div className="absolute left-0 z-20 mt-1 flex min-w-40 flex-col gap-1 border border-slate-200 bg-white p-2 shadow-md sm:left-auto sm:right-0">
            {isCatalog && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSetValues({ published: true })}
                  className="min-h-11 rounded-lg bg-green-600 px-3 text-left text-sm font-semibold text-white disabled:opacity-50"
                >
                  Publish
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSetValues({ published: false })}
                  className="min-h-11 rounded-lg bg-slate-600 px-3 text-left text-sm font-semibold text-white disabled:opacity-50"
                >
                  Disable
                </button>
              </>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onDelete}
              className="min-h-11 rounded-lg bg-red-600 px-3 text-left text-sm font-semibold text-white disabled:opacity-50"
            >
              Archive
            </button>
          </div>
        </details>
      )}

      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-sm font-medium text-brand-700 hover:text-brand-900"
      >
        Clear selection
      </button>
    </div>
  );
}

function BatchSelect({
  label,
  field,
  disabled,
  onPick,
}: {
  label: string;
  field: FieldDef;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <Select
      ariaLabel={label}
      value={value}
      placeholder={`${label}…`}
      options={field.options ?? []}
      disabled={disabled}
      triggerClassName="min-h-9 border-brand-300 py-1.5 font-medium text-slate-700"
      onChange={(next) => {
        if (next) {
          onPick(next);
          setValue('');
        }
      }}
    />
  );
}

function Checkbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (e: unknown) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = !checked && indeterminate === true;
    }
  }, [checked, indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
    />
  );
}

function SortIcon({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`h-3.5 w-3.5 ${dir ? 'text-slate-900' : 'text-slate-300'}`}
    >
      {dir === 'asc' ? (
        <path d="M10 5l4 6H6l4-6Z" />
      ) : dir === 'desc' ? (
        <path d="M10 15l-4-6h8l-4 6Z" />
      ) : (
        <path d="M10 4l3 4H7l3-4Zm0 12l-3-4h6l-3 4Z" />
      )}
    </svg>
  );
}

export function ProductThumbnail({ doc }: { doc: CollectionDoc }) {
  const source = productThumbnailSource(doc);
  const label = reviewLabel(doc);
  // A live product's photo that the public address refuses (e.g. added after
  // the last approval) falls back to the admin preview.
  const [publicFailed, setPublicFailed] = useState(false);
  const previewId =
    source?.kind === 'admin' || (source?.kind === 'public' && publicFailed) ? source.imageId : null;
  const [preview, setPreview] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!previewId) return;
    let cancelled = false;
    adminThumbnail(previewId).then(
      (url) => !cancelled && setPreview({ id: previewId, url }),
      () => !cancelled && setPreview({ id: previewId, url: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [previewId]);
  const badge = label ? (
    <span className="absolute -left-1 -top-1 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white shadow-sm">
      {label}
    </span>
  ) : null;
  const frame = (image: ReactNode) => (
    <span className="relative inline-block">
      {image}
      {badge}
    </span>
  );
  const empty = frame(
    <span className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-slate-300">
      —
    </span>,
  );
  if (source?.kind === 'public' && !publicFailed)
    return frame(
      <img
        src={imageUrl(source.imageId)}
        alt=""
        onError={() => setPublicFailed(true)}
        className="h-10 w-10 rounded-md border border-slate-200 object-cover"
      />,
    );
  if (source?.kind === 'alibaba')
    return frame(
      <img
        src={source.url}
        alt=""
        referrerPolicy="no-referrer"
        className={`h-10 w-10 rounded-md border object-cover ${
          source.copied ? 'border-slate-200' : 'border-dashed border-slate-300'
        }`}
        title={
          source.copied
            ? 'Copied to our storage from this Alibaba photo'
            : 'Alibaba source preview; not yet imported for publication'
        }
      />,
    );
  if (previewId) {
    const url = preview?.id === previewId ? preview.url : undefined;
    if (url)
      return frame(
        <img
          src={url}
          alt=""
          className="h-10 w-10 rounded-md border border-slate-200 object-cover"
        />,
      );
    if (url === undefined)
      return frame(
        <span
          aria-hidden="true"
          data-thumbnail-loading
          className="block h-10 w-10 animate-pulse rounded-md bg-slate-100"
        />,
      );
  }
  return empty;
}

function InlineSelect({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      ariaLabel={field.label}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder="—"
      options={field.options ?? []}
      triggerClassName="min-h-8 rounded-md px-2 py-1 capitalize"
      onChange={onChange}
    />
  );
}

function PublishToggle({
  published,
  busy,
  onToggle,
}: { published: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onToggle}
      title={
        published ? 'Click to disable (hide from public)' : 'Click to publish (show to public)'
      }
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition ${
        published
          ? 'bg-green-100 text-green-700 hover:bg-green-200'
          : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
      }`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${published ? 'bg-green-500' : 'bg-slate-400'}`}
      />
      {published ? 'Published' : 'Disabled'}
    </button>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Per-column width caps for table text. The table is `min-w-max`, so without a cap a
 * single long product name stretches its column and pushes the rest off screen.
 */
const TEXT_CELL_WIDTHS: Record<string, string> = {
  name: 'max-w-56',
  description: 'max-w-72',
  slug: 'max-w-48',
  skuCode: 'max-w-40',
  modName: 'max-w-40',
  reviewIdentity: 'max-w-44',
  reviewSourceCategory: 'max-w-48',
  reviewModel: 'max-w-40',
  reviewVariants: 'max-w-36',
  reviewPricing: 'max-w-56',
  websiteSubcategories: 'max-w-56',
};
const DEFAULT_TEXT_CELL_WIDTH = 'max-w-48';

/**
 * A table value clamped to two lines with an ellipsis, the full value available through
 * the native title tooltip. TanStack Table is headless — it owns sorting, selection and
 * column state, never presentation — so cell rendering like this is ours to provide.
 */
function TextCell({ field, value }: { field: string; value: unknown }) {
  const text = formatCell(value);
  const width = TEXT_CELL_WIDTHS[field] ?? DEFAULT_TEXT_CELL_WIDTH;
  return (
    <span
      className={`line-clamp-2 ${width} whitespace-normal break-words`}
      title={text === '—' ? undefined : text}
    >
      {text}
    </span>
  );
}
