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
import { PRODUCT_FAMILY_OPTIONS } from '@vibelingan-channel/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../../components/form/Select.tsx';
import { FileDownloadLink } from './FileDownloadLink.tsx';
import { FilterBuilder } from './FilterBuilder.tsx';
import { PreviewModal } from './PreviewModal.tsx';
import { RecordForm } from './RecordForm.tsx';
import { alibabaSourcePreviewUrls } from './alibaba-source-preview.ts';
import { productReviewCellValue } from './alibaba-source-review.ts';
import {
  batchRemoveRecords,
  batchUpdateRecords,
  createRecord,
  fetchProductReviewSummary,
  imageUrl,
  listRecords,
  markProductReviewed,
  removeRecord,
  updateRecord,
} from './api.ts';
import {
  type AdminProductFamily,
  adminProductFamilyFromSearch,
  adminProductFamilySearch,
  productFamilyListArgs,
} from './product-family-tabs.ts';
import type { DashboardSection } from './sections.ts';

const PAGE_SIZE = 20;

interface Props {
  collection: CollectionDef;
  section: DashboardSection;
  role: string;
}

export function CollectionView({ collection, section, role }: Props) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [filter, setFilter] = useState<FilterModel | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<CollectionDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<CollectionDoc | null>(null);

  const isCatalog = section.catalog === true;
  const isProducts = collection.name === 'products';
  const canReviewAlibabaProducts = isProducts && role === 'admin';
  const [productFamily, setProductFamily] = useState<AdminProductFamily>(() =>
    isProducts && typeof window !== 'undefined'
      ? adminProductFamilyFromSearch(window.location.search)
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

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['list', collection.name] });
    if (isProducts) queryClient.invalidateQueries({ queryKey: ['product-review-summary'] });
  }

  function clearSelection() {
    setRowSelection({});
  }

  const createMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) => createRecord(collection.name, values),
    onSuccess: () => {
      setCreating(false);
      invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; values: Record<string, unknown> }) =>
      updateRecord(collection.name, vars.id, vars.values),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeRecord(collection.name, id),
    onSuccess: invalidate,
  });

  const batchUpdateMutation = useMutation({
    mutationFn: (vars: { ids: string[]; values: Record<string, unknown> }) =>
      batchUpdateRecords(collection.name, vars.ids, vars.values),
    onSuccess: () => {
      clearSelection();
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

  function patch(id: string, values: Record<string, unknown>) {
    updateMutation.mutate({ id, values });
  }

  // Drop any stale selection when the visible result set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset triggers
  useEffect(() => {
    setRowSelection({});
  }, [search, filter, page, productFamily]);

  function changeProductFamily(next: AdminProductFamily) {
    setProductFamily(next);
    setPage(1);
    clearSelection();
    if (typeof window !== 'undefined') {
      const nextUrl = `${window.location.pathname}${adminProductFamilySearch(window.location.search, next)}${window.location.hash}`;
      window.history.pushState(null, '', nextUrl);
    }
  }

  useEffect(() => {
    if (!isProducts) return;
    const recoverFamily = () => {
      setProductFamily(adminProductFamilyFromSearch(window.location.search));
      setPage(1);
      setRowSelection({});
    };
    window.addEventListener('popstate', recoverFamily);
    return () => window.removeEventListener('popstate', recoverFamily);
  }, [isProducts]);

  const tableFields = useMemo(() => {
    const visible = collection.fields.filter(
      (field) => !field.hideInTable && !(isCatalog && field.name === 'published'),
    );
    // Product rows are an operator review queue, not a raw dump of the legacy
    // product document. Fields that Alibaba does not supply (slug, series,
    // website prices) stay editable in the form but do not become columns full
    // of misleading blanks. The source evidence columns below replace them.
    return isProducts
      ? visible.filter((field) => ['name', 'productFamily', 'category'].includes(field.name))
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
        header: field.label,
        cell: ({ row }) => {
          const doc = row.original;
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
            onToggle={() =>
              patch(row.original._id, { published: !(row.original.published === true) })
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
              onClick={() => setEditing(doc)}
              className="ml-3 text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm('Delete this record?')) removeMutation.mutate(doc._id);
              }}
              className="ml-3 text-sm font-medium text-red-600 hover:text-red-700"
            >
              Delete
            </button>
          </div>
        );
      },
    });

    return cols;
  }, [tableFields, isCatalog, isProducts, inlineEdit]);

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
          onClick={() => setCreating(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          New {singular}
        </button>
      </header>

      {isProducts && (
        <div className="mt-6 border-b border-slate-200 pb-3">
          <fieldset className="hidden min-w-0 gap-1 overflow-x-auto sm:flex">
            <legend className="sr-only">Product family</legend>
            <ProductFamilyTab
              label="All products"
              value={null}
              selected={productFamily === null}
              pendingCount={reviewSummary?.pendingTotal ?? 0}
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
            placeholder={`All products${(reviewSummary?.pendingTotal ?? 0) > 0 ? ' • New' : ''}`}
            options={PRODUCT_FAMILY_OPTIONS.map((value) => ({
              value,
              label: `${productFamilyLabel(value)}${(reviewSummary?.byFamily[value] ?? 0) > 0 ? ' • New' : ''}`,
            }))}
            className="block sm:hidden"
            triggerClassName="font-medium text-slate-800"
            onChange={(value) => changeProductFamily((value || null) as AdminProductFamily)}
          />
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
          collection={collection}
          busy={batchUpdateMutation.isPending || batchRemoveMutation.isPending}
          onClear={clearSelection}
          onSetValues={(values) => batchUpdateMutation.mutate({ ids: selectedIds, values })}
          onDelete={() => {
            if (confirm(`Delete ${selectedIds.length} record(s)?`)) {
              batchRemoveMutation.mutate(selectedIds);
            }
          }}
        />
      )}

      <div className="mt-4 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white">
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
        </div>
      </div>

      {creating && (
        <RecordForm
          collection={collection}
          title={`New ${singular}`}
          {...(productFamily ? { defaults: { productFamily } } : {})}
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
          submitting={updateMutation.isPending}
          error={updateMutation.error as Error | null}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => updateMutation.mutate({ id: editing._id, values })}
        />
      )}

      {previewing && (
        <PreviewModal
          doc={previewing}
          canMarkReviewed={canReviewAlibabaProducts}
          reviewBusy={reviewMutation.isPending}
          reviewError={reviewMutation.error as Error | null}
          onMarkReviewed={() => reviewMutation.mutate(previewing._id)}
          onClose={() => setPreviewing(null)}
          onEdit={() => {
            setEditing(previewing);
            setPreviewing(null);
          }}
        />
      )}
    </div>
  );
}

function productFamilyLabel(productFamily: ProductFamily): string {
  switch (productFamily) {
    case 'headphones':
      return 'Headphones';
    case 'ai-gadgets':
      return 'AI Gadgets';
    case 'toys':
      return 'Toys';
    case 'misc':
      return 'Other Electronics & Toys';
  }
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
            aria-label={`${pendingCount} new product${pendingCount === 1 ? '' : 's'} to review`}
            title={`${pendingCount} new product${pendingCount === 1 ? '' : 's'} to review`}
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
  collection,
  busy,
  onClear,
  onSetValues,
  onDelete,
}: {
  count: number;
  isCatalog: boolean;
  isUsers: boolean;
  collection: CollectionDef;
  busy: boolean;
  onClear: () => void;
  onSetValues: (values: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const roleField = collection.fields.find((f) => f.name === 'role');
  const statusField = collection.fields.find((f) => f.name === 'status');

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
      <span className="text-sm font-semibold text-brand-900">{count} selected</span>

      {isCatalog && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetValues({ published: true })}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            Publish
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetValues({ published: false })}
            className="rounded-lg bg-slate-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
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
        className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
      >
        Delete
      </button>

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
  const ids = Array.isArray(doc.imageIds) ? (doc.imageIds as string[]) : [];
  const badge =
    doc.alibabaReviewPending === true ? (
      <span className="absolute -left-1 -top-1 rounded bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white shadow-sm">
        New
      </span>
    ) : null;
  if (ids[0]) {
    return (
      <span className="relative inline-block">
        <img
          src={imageUrl(ids[0])}
          alt=""
          className="h-10 w-10 rounded-md border border-slate-200 object-cover"
        />
        {badge}
      </span>
    );
  }
  const sourceUrl = alibabaSourcePreviewUrls(doc.alibabaSourceImageUrls, 1)[0];
  if (sourceUrl) {
    return (
      <span className="relative inline-block">
        <img
          src={sourceUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="h-10 w-10 rounded-md border border-dashed border-slate-300 object-cover"
          title="Alibaba source preview; not yet imported for publication"
        />
        {badge}
      </span>
    );
  }
  return (
    <span className="relative inline-block">
      <span className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-slate-300">
        —
      </span>
      {badge}
    </span>
  );
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

function PublishToggle({ published, onToggle }: { published: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
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
