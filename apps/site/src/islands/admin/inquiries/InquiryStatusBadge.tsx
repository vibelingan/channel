import {
  type InquiryStatus,
  inquiryStatusLabels,
} from '@vibelingan-channel/shared/catalog-inquiry';

export function InquiryStatusBadge({ status }: { status: InquiryStatus }) {
  const styles: Record<InquiryStatus, string> = {
    new: 'bg-amber-100 text-amber-900',
    in_progress: 'bg-blue-100 text-blue-800',
    waiting_customer: 'bg-violet-100 text-violet-800',
    completed: 'bg-emerald-100 text-emerald-800',
    closed: 'bg-slate-100 text-slate-700',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status]}`}
    >
      {inquiryStatusLabels[status]}
    </span>
  );
}
