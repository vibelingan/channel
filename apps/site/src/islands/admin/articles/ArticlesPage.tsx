import { useState } from 'react';
import { ArticleForm } from './ArticleForm.tsx';
import { useArticleDraft, useArticleList } from './useArticleDrafts.ts';

export function ArticlesPage({
  onGuardChange,
  canLeave,
}: { onGuardChange: (guard: (() => boolean) | null) => void; canLeave: () => boolean }) {
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const list = useArticleList(query);
  const detail = useArticleDraft(selected === 'new' ? null : selected);
  const back = () => {
    if (canLeave()) {
      setSelected(null);
      void list.refetch();
    }
  };
  if (selected === 'new')
    return <ArticleForm key="new" initial={null} onBack={back} onGuardChange={onGuardChange} />;
  if (selected) {
    if (detail.data)
      return (
        <ArticleForm
          key={selected}
          initial={detail.data}
          onBack={back}
          onGuardChange={onGuardChange}
        />
      );
    return (
      <div className="p-6">
        <button type="button" onClick={back}>
          ← Articles
        </button>
        {detail.isError ? (
          <p role="alert">
            {detail.error.message}
            <button type="button" className="ml-3 underline" onClick={() => void detail.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <output>Opening article…</output>
        )}
      </div>
    );
  }
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Articles</h1>
          <p className="mt-1 text-sm text-slate-500">
            Private drafts. Continue writing or start a new article.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSelected('new')}
          className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white"
        >
          New article
        </button>
      </div>
      <label className="mb-4 block text-sm text-slate-700">
        Search titles
        <input
          aria-label="Search titles"
          maxLength={100}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ml-3 max-w-full rounded-lg border border-slate-300 px-3 py-2"
        />
      </label>
      {list.isPending && <output>Loading articles…</output>}
      {list.isError && (
        <p role="alert" className="text-sm text-red-700">
          Could not load articles.{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-50 text-slate-600">
            <tr>
              <th className="p-3">Title</th>
              <th className="p-3">Status</th>
              <th className="p-3">Updated</th>
              <th className="p-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-article-id={row.id} className="border-b border-slate-100">
                <td className="max-w-xs break-words p-3">{row.title || 'Untitled article'}</td>
                <td className="p-3">{row.published ? 'Published version exists' : 'Draft'}</td>
                <td className="whitespace-nowrap p-3">
                  {new Date(row.updatedAt).toLocaleDateString()}
                </td>
                <td className="p-3">
                  <button
                    type="button"
                    className="min-h-10 px-2 font-semibold text-slate-700 underline"
                    onClick={() => setSelected(row.id)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !list.isPending && !list.isError && (
          <p className="p-5 text-sm text-slate-500">
            {query ? 'No matching articles.' : 'No articles yet.'}
          </p>
        )}
      </div>
      {list.hasNextPage && (
        <button
          type="button"
          disabled={list.isFetchingNextPage}
          className="mt-4 min-h-11 rounded-lg border px-4 text-sm"
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </button>
      )}
    </div>
  );
}
