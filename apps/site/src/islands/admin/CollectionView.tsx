import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollectionDef, CollectionDoc, FieldDef } from '@vibelingan-channel/shared';
import { useMemo, useState } from 'react';
import { PreviewModal } from './PreviewModal.tsx';
import { RecordForm } from './RecordForm.tsx';
import { createRecord, imageUrl, listRecords, removeRecord, updateRecord } from './api.ts';
import type { DashboardSection } from './sections.ts';

const PAGE_SIZE = 20;

interface Props {
  collection: CollectionDef;
  section: DashboardSection;
}

export function CollectionView({ collection, section }: Props) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [editing, setEditing] = useState<CollectionDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [previewing, setPreviewing] = useState<CollectionDoc | null>(null);

  const isCatalog = section.catalog === true;
  const inlineEdit = useMemo(() => new Set(section.inlineEdit ?? []), [section.inlineEdit]);
  const singular = section.label.replace(/s$/, '');

  const queryKey = ['list', collection.name, page, search] as const;
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => listRecords({ collection: collection.name, page, pageSize: PAGE_SIZE, search }),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['list', collection.name] });
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

  function patch(id: string, values: Record<string, unknown>) {
    updateMutation.mutate({ id, values });
  }

  // Catalog renders a dedicated thumbnail + status column, so drop those from
  // the generic field columns.
  const tableFields = collection.fields.filter(
    (f) => !f.hideInTable && !(isCatalog && f.name === 'published'),
  );
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const colCount = tableFields.length + (isCatalog ? 2 : 0) + 1;

  return (
    <div className="p-8">
      <header className="flex items-center justify-between">
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

      <form
        className="mt-6 flex gap-2"
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
          className="w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900"
        />
        <button
          type="submit"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Search
        </button>
      </form>

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {isCatalog && <th className="w-16 px-4 py-3 font-medium">Image</th>}
              {tableFields.map((field) => (
                <th key={field.name} className="px-4 py-3 font-medium">
                  {field.label}
                </th>
              ))}
              {isCatalog && <th className="px-4 py-3 font-medium">Status</th>}
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
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
            {data?.items.map((doc) => (
              <tr key={doc._id} className="hover:bg-slate-50">
                {isCatalog && (
                  <td className="px-4 py-3">
                    <Thumb doc={doc} />
                  </td>
                )}
                {tableFields.map((field) => (
                  <td key={field.name} className="px-4 py-3 text-slate-700">
                    {inlineEdit.has(field.name) && field.type === 'select' ? (
                      <InlineSelect
                        field={field}
                        value={doc[field.name]}
                        onChange={(v) => patch(doc._id, { [field.name]: v })}
                      />
                    ) : (
                      formatCell(doc[field.name])
                    )}
                  </td>
                ))}
                {isCatalog && (
                  <td className="px-4 py-3">
                    <PublishToggle
                      published={doc.published === true}
                      onToggle={() => patch(doc._id, { published: !(doc.published === true) })}
                    />
                  </td>
                )}
                <td className="whitespace-nowrap px-4 py-3 text-right">
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
                </td>
              </tr>
            ))}
            {data && data.items.length === 0 && !isLoading && (
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

function Thumb({ doc }: { doc: CollectionDoc }) {
  const ids = Array.isArray(doc.imageIds) ? (doc.imageIds as string[]) : [];
  if (ids[0]) {
    return (
      <img
        src={imageUrl(ids[0])}
        alt=""
        className="h-10 w-10 rounded-md border border-slate-200 object-cover"
      />
    );
  }
  return (
    <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-100 text-slate-300">
      —
    </div>
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
    <select
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm capitalize outline-none focus:border-slate-900"
    >
      <option value="">—</option>
      {field.options?.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
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
