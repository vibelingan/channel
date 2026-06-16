import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CollectionDef, CollectionDoc } from '@vibelingan-channel/shared';
import { useState } from 'react';
import { RecordForm } from './RecordForm.tsx';
import { createRecord, listRecords, removeRecord, updateRecord } from './api.ts';

const PAGE_SIZE = 20;

export function CollectionView({ collection }: { collection: CollectionDef }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [editing, setEditing] = useState<CollectionDoc | null>(null);
  const [creating, setCreating] = useState(false);

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

  const tableFields = collection.fields.filter((f) => !f.hideInTable);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{collection.label}</h1>
          {collection.description && (
            <p className="mt-1 text-sm text-slate-500">{collection.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          New {collection.label.replace(/s$/, '')}
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
              {tableFields.map((field) => (
                <th key={field.name} className="px-4 py-3 font-medium">
                  {field.label}
                </th>
              ))}
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td
                  colSpan={tableFields.length + 1}
                  className="px-4 py-8 text-center text-slate-400"
                >
                  Loading…
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={tableFields.length + 1} className="px-4 py-8 text-center text-red-600">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {data?.items.map((doc) => (
              <tr key={doc._id} className="hover:bg-slate-50">
                {tableFields.map((field) => (
                  <td key={field.name} className="px-4 py-3 text-slate-700">
                    {formatCell(doc[field.name])}
                  </td>
                ))}
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(doc)}
                    className="text-sm font-medium text-slate-700 hover:text-slate-900"
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
                <td
                  colSpan={tableFields.length + 1}
                  className="px-4 py-8 text-center text-slate-400"
                >
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
          title={`New ${collection.label.replace(/s$/, '')}`}
          submitting={createMutation.isPending}
          error={createMutation.error as Error | null}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => createMutation.mutate(values)}
        />
      )}

      {editing && (
        <RecordForm
          collection={collection}
          title={`Edit ${collection.label.replace(/s$/, '')}`}
          initial={editing}
          submitting={updateMutation.isPending}
          error={updateMutation.error as Error | null}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => updateMutation.mutate({ id: editing._id, values })}
        />
      )}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
