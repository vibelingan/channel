import { useEffect, useState } from 'react';
import type { TurnPhase } from './model';

export function activityCopy(phase: TurnPhase, activity?: string, hasContent = false) {
  if (phase === 'stopping')
    return { title: 'Stopping…', detail: 'Keeping the answer you have already received.' };
  if (phase === 'reconnecting')
    return {
      title: 'Reconnecting…',
      detail: 'Your question is kept. You do not need to send it again.',
    };
  if (phase === 'reading' && activity) {
    if (['knowledge_search', 'Checking public company information'].includes(activity))
      return {
        title: 'Checking company information…',
        detail: 'Looking through our approved sources.',
      };
    if (['product_search', 'Checking current published products'].includes(activity))
      return {
        title: 'Finding matching products…',
        detail: 'Checking the current public catalog.',
      };
    if (['model_answer', 'Preparing a helpful response'].includes(activity))
      return { title: 'Preparing your answer…', detail: 'Bringing the relevant details together.' };
  }
  if (phase === 'streaming' && hasContent)
    return { title: 'Writing your answer…', detail: 'You can read along as it arrives.' };
  if (phase === 'reading')
    return {
      title: 'Checking the details…',
      detail: 'Looking for information relevant to your question.',
    };
  return { title: 'Thinking…', detail: 'Getting your question ready.' };
}

/** Only received events name an activity. The timer adds reassurance, not a fake stage. */
export function AssistantActivity({
  phase,
  activity,
  hasContent = false,
}: {
  phase: TurnPhase;
  activity?: string;
  hasContent?: boolean;
}) {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => setTakingLonger(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, []);
  const copy = activityCopy(phase, activity, hasContent);
  return (
    <output
      data-testid="assistant-activity"
      data-activity-phase={phase}
      aria-label="Answer status"
      aria-live="polite"
      aria-atomic="true"
      className="assistant-activity flex min-h-[4.25rem] items-start gap-3 rounded-2xl border border-brand-100/70 bg-brand-50/80 px-4 py-3 text-brand-950"
    >
      <span
        className="assistant-activity-dots mt-2.5 inline-flex shrink-0 gap-1"
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold leading-5">{copy.title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-brand-800">{copy.detail}</span>
        {takingLonger && !['stopping', 'reconnecting'].includes(phase) && (
          <span className="mt-1 block text-xs leading-5 text-ink-muted">
            This is taking a little longer. Your question is kept while you wait.
          </span>
        )}
      </span>
    </output>
  );
}
