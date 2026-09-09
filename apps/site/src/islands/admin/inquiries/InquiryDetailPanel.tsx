import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type InquiryDetail,
  inquiryStatusLabels,
  isTerminalInquiry,
  nextInquiryStatuses,
} from '@vibelingan-channel/shared/catalog-inquiry';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Select } from '../../../components/form/Select.tsx';
import { AdminApiError } from '../api.ts';
import { InquiryStatusBadge } from './InquiryStatusBadge.tsx';
import { InquirySummary } from './InquirySummary.tsx';
import { getInquiry, inquiryRequest, inquiryTime } from './inquiry-api.ts';

const button =
  'min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50';
function InquiryEditor({
  item,
  onReload,
  onPending,
}: { item: InquiryDetail; onReload: () => void; onPending: (pending: boolean) => void }) {
  const client = useQueryClient();
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const attempt = useRef<{ signature: string; id: string } | undefined>(undefined);
  const saving = useRef(false);
  const mutation = useMutation({
    mutationFn: (input: unknown) => inquiryRequest(input),
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['product-inquiries'] });
    },
  });
  const needsReason =
    status === 'closed' || status === 'completed' || isTerminalInquiry(item.status);
  const conflict =
    mutation.error instanceof AdminApiError && mutation.error.code === 'VERSION_CONFLICT';
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-5"
      aria-label="Process inquiry"
      data-inquiry-version={item.version}
    >
      <h2 className="font-semibold text-lg">Follow up</h2>
      <p className="mt-1 text-sm text-slate-600">
        Current status: <InquiryStatusBadge status={item.status} />
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Viewing does not mark this inquiry as processed. Contact the buyer through your normal sales
        channel and record progress here.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        Completed means inquiry follow-up is finished, not that an order was paid or fulfilled.
        Complete, close and reopen actions require a reason. A note alone does not process an
        inquiry.
      </p>
      <form
        className="mt-4 space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving.current) return;
          const changes = {
            action: 'update',
            id: item.id,
            version: item.version,
            ...(status ? { status } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          };
          const signature = JSON.stringify(changes);
          if (!attempt.current || attempt.current.signature !== signature)
            attempt.current = { signature, id: crypto.randomUUID() };
          saving.current = true;
          onPending(true);
          setMessage('');
          try {
            await mutation.mutateAsync({ ...changes, operationId: attempt.current.id });
            setStatus('');
            setNote('');
            setMessage('Changes saved.');
          } catch {
            /* Render the error and preserve input + operation id for safe retry. */
          } finally {
            saving.current = false;
            onPending(false);
          }
        }}
      >
        <Select
          label="Next status"
          value={status}
          disabled={mutation.isPending || conflict}
          placeholder="Keep current status (add note only)"
          options={nextInquiryStatuses(item.status).map((value) => ({
            value,
            label: isTerminalInquiry(item.status)
              ? 'Reopen — in progress'
              : inquiryStatusLabels[value],
          }))}
          onChange={setStatus}
        />
        <label className="block text-sm font-medium">
          {needsReason ? 'Reason / internal note (required)' : 'Internal note'}
          <textarea
            className="mt-2 block min-h-28 w-full rounded-lg border border-slate-300 p-3 font-normal"
            value={note}
            maxLength={2000}
            required={needsReason}
            disabled={mutation.isPending || conflict}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <p className="text-xs text-slate-500">
          Internal only; excluded from the printable inquiry summary. Notes cannot be edited or
          deleted.
        </p>
        <button
          className={`${button} bg-brand-700 text-white`}
          disabled={
            mutation.isPending ||
            conflict ||
            (!status && !note.trim()) ||
            (needsReason && (!note.trim() || !status))
          }
          type="submit"
        >
          {mutation.isPending ? 'Saving…' : 'Save follow-up'}
        </button>
        {mutation.isError && (
          <div role="alert" className="space-y-2 text-sm text-rose-700">
            <p>
              {mutation.error instanceof AdminApiError
                ? mutation.error.message
                : 'Save result is uncertain. Retry the same change to check its result.'}
            </p>
            {conflict && (
              <button type="button" className={button} onClick={onReload}>
                Reload latest (discard unsaved edit)
              </button>
            )}
          </div>
        )}
        {message && <output className="block text-sm text-emerald-700">{message}</output>}
      </form>
    </section>
  );
}
export function InquiryDetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const detail = useQuery({
    queryKey: ['product-inquiries', 'detail', id],
    queryFn: ({ signal }) => getInquiry(id, signal),
    gcTime: 0,
  });
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const item = detail.data?.item;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className={button} onClick={onBack} type="button" disabled={saving}>
          ← Back to inquiries
        </button>
        <button
          className={button}
          type="button"
          disabled={!item || detail.isError || detail.isFetching || saving}
          onClick={() => window.print()}
        >
          Print / Save PDF
        </button>
      </div>
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
        Inquiry detail
      </h1>
      {detail.isPending ? (
        <output>Loading inquiry…</output>
      ) : detail.isError ? (
        <div role="alert">
          <p>Could not load inquiry: {detail.error.message}</p>
          <button className={button} type="button" onClick={() => detail.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        item && (
          <>
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              {item.notification === 'disabled-local' ? 'Local workspace · ' : ''}Email
              notifications disabled. Saving or following up here does not send email.
            </p>
            {item.version > 0 && (
              <output className="block text-sm text-emerald-700">
                Follow-up saved · Last update {inquiryTime(item.updatedAt)} (HK)
              </output>
            )}
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,1fr)]">
              <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-5">
                <InquirySummary item={item} />
              </div>
              <div className="min-w-0 space-y-5">
                <InquiryEditor
                  onPending={setSaving}
                  key={`${item.id}-${item.version}-${editorEpoch}`}
                  item={item}
                  onReload={() => {
                    void detail.refetch().then(() => setEditorEpoch((value) => value + 1));
                  }}
                />
                <section className="rounded-xl border border-slate-200 p-5 text-sm">
                  <h2 className="font-semibold">Current catalog status</h2>
                  <p className="mt-2">
                    {detail.data.currentProduct.state === 'same'
                      ? 'The product details have not changed since this inquiry was submitted.'
                      : detail.data.currentProduct.state === 'missing'
                        ? 'The product is no longer present. The submitted snapshot is retained.'
                        : detail.data.currentProduct.state === 'unavailable'
                          ? 'The product is not currently published / available. The submitted snapshot is retained.'
                          : 'The product has changed since submission. Review current details before replying.'}
                  </p>
                </section>
                <section className="rounded-xl border border-slate-200 p-5">
                  <h2 className="font-semibold">Internal history</h2>
                  {!item.events.length && (
                    <p className="mt-2 text-sm text-slate-500">No follow-up yet.</p>
                  )}
                  <ol className="mt-3 space-y-4">
                    {[...item.events].reverse().map((event) => (
                      <li key={event.id} className="border-l-2 border-slate-200 pl-3 text-sm">
                        <p className="font-medium">
                          {event.from === event.to
                            ? 'Note added'
                            : `${inquiryStatusLabels[event.from]} → ${inquiryStatusLabels[event.to]}`}
                        </p>
                        <p className="text-xs text-slate-500">
                          {event.actorName} · {inquiryTime(event.at)} (HK)
                        </p>
                        {event.note && (
                          <p className="mt-1 whitespace-pre-wrap break-words">{event.note}</p>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            </div>
            {createPortal(
              <div id="inquiry-print" style={{ display: 'none' }}>
                <InquirySummary item={item} />
              </div>,
              document.body,
            )}
            <style>
              {
                '@media print { @page { margin: 16mm; } body:has(#inquiry-print) > :not(#inquiry-print) { display: none !important; } #inquiry-print { display: block !important; color: #000; font-size: 11pt; } #inquiry-print section { break-inside: auto; } #inquiry-print tr { break-inside: avoid; } }'
              }
            </style>
          </>
        )
      )}
    </div>
  );
}
