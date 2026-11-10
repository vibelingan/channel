import { type Ref, useId, useRef } from 'react';

/** The assistant server refuses longer questions (MAX_QUESTION_CHARS in ai-bff). */
export const MAX_QUESTION_CHARS = 2000;

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  working,
  stopping,
  disabled = false,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  working: boolean;
  stopping: boolean;
  disabled?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const composing = useRef(false);
  return (
    <form
      method="post"
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!working && !disabled && value.trim()) onSend();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your question
      </label>
      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        maxLength={MAX_QUESTION_CHARS}
        disabled={disabled}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey ||
            composing.current ||
            event.nativeEvent.isComposing
          )
            return;
          event.preventDefault();
          if (!working && !disabled && value.trim()) onSend();
        }}
        placeholder="Ask about products or your project…"
        className="min-h-12 min-w-0 flex-1 resize-none rounded-2xl border border-slate-200 bg-surface-alt px-3.5 py-3 text-sm leading-5 transition-colors focus:border-brand-400 focus:outline-2 focus:outline-offset-1 focus:outline-brand-500 disabled:bg-slate-100"
      />
      {working ? (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="min-h-12 min-w-[4.5rem] rounded-xl border border-brand-200 bg-brand-50 px-3 text-xs font-semibold text-brand-900 transition-colors hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50"
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="min-h-12 min-w-[4.5rem] rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white transition-colors hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-40"
        >
          Send
        </button>
      )}
    </form>
  );
}
