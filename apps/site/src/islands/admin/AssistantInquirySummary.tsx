import * as React from 'react';
/** Read-only record evidence; never turns chat text into admin form fields. */
export function AssistantInquirySummary({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const requirement: unknown = Reflect.get(value, 'requirement');
  if (typeof requirement !== 'string' || !requirement || requirement.length > 4000) return null;
  return (
    <section
      aria-label="Confirmed assistant inquiry"
      className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm"
    >
      <h3 className="font-semibold">Customer-confirmed requirement</h3>
      <p className="mt-2 whitespace-pre-wrap break-words">{requirement}</p>
      <p className="mt-2 text-xs text-slate-600">
        Submitted through the website assistant. Contact permission applies to this inquiry only.
      </p>
    </section>
  );
}
