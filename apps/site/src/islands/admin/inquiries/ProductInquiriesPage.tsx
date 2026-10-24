import { useQuery, useQueryClient } from '@tanstack/react-query';
import { inquiryStatusLabels } from '@vibelingan-channel/shared/catalog-inquiry';
import { useRef, useState } from 'react';
import { Select } from '../../../components/form/Select.tsx';
import { InquiryDetailPanel } from './InquiryDetailPanel.tsx';
import { InquiryStatusBadge } from './InquiryStatusBadge.tsx';
import { inquiryTime, listInquiries } from './inquiry-api.ts';

export function ProductInquiriesPage() {
  const client = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const returnId = useRef<string | null>(null);
  const list = useQuery({
    queryKey: ['product-inquiries', 'list', page, status],
    queryFn: ({ signal }) => listInquiries(page, status, signal),
    gcTime: 0,
  });
  if (selected)
    return (
      <InquiryDetailPanel
        key={selected}
        id={selected}
        onBack={() => {
          setSelected(null);
          requestAnimationFrame(() =>
            document.getElementById(`inquiry-${returnId.current}`)?.focus(),
          );
        }}
      />
    );
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold">Product Inquiries</h1>
        <p className="mt-2 text-sm text-slate-600">
          Review product requests, record follow-up and close the loop. These are not orders.
        </p>
      </header>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Select
          label="Status filter"
          value={status}
          className="w-64 max-w-full"
          placeholder="All statuses"
          options={Object.entries(inquiryStatusLabels).map(([value, label]) => ({ value, label }))}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <button
          type="button"
          className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm disabled:opacity-50"
          disabled={list.isFetching}
          onClick={() => client.invalidateQueries({ queryKey: ['product-inquiries'] })}
        >
          Refresh inquiries
        </button>
      </div>
      {list.isPending ? (
        <output>Loading inquiries…</output>
      ) : list.isError ? (
        <p role="alert" className="text-rose-700">
          Could not load inquiries: {list.error.message}
        </p>
      ) : (
        <>
          <output className="block text-sm text-slate-600">
            {list.data.newCount} unprocessed · {list.data.total} matching inquiries · Times in Hong
            Kong
          </output>
          {!list.data.items.length ? (
            <p className="rounded-xl border border-slate-200 p-8 text-slate-500">
              No inquiries in this view.
            </p>
          ) : (
            <ul className="space-y-3">
              {list.data.items.map((item) => (
                <li key={item.id}>
                  <button
                    id={`inquiry-${item.id}`}
                    type="button"
                    onClick={() => {
                      returnId.current = item.id;
                      setSelected(item.id);
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white p-5 text-left transition hover:border-brand-500 focus-visible:outline-2 focus-visible:outline-brand-700"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <InquiryStatusBadge status={item.status} />
                      <span className="text-xs text-slate-500">{inquiryTime(item.createdAt)}</span>
                    </div>
                    <p className="mt-3 break-words font-semibold text-slate-900">
                      {item.productName}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {item.intent === 'customization' ? 'Customization' : 'Product quote'} ·
                      Quantity {item.quantity}
                    </p>
                    <p className="mt-2 break-all font-mono text-xs text-slate-500">{item.id}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-end gap-3 text-sm">
            <button
              type="button"
              className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
              disabled={page <= 1 || list.isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} / {Math.max(1, Math.ceil(list.data.total / list.data.pageSize))}
            </span>
            <button
              type="button"
              className="min-h-11 rounded-lg border px-3 disabled:opacity-40"
              disabled={page * list.data.pageSize >= list.data.total || list.isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
