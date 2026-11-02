import { useEffect, useRef, useState } from 'react';

export function useChatViewport(open: boolean, revision: string) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const previous = useRef(revision);
  useEffect(() => {
    const changed = previous.current !== revision;
    previous.current = revision;
    if (!open) return;
    if (!following.current) {
      if (changed) setHasNew(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = transcriptRef.current;
      // A visitor typing in a form inside the conversation keeps that field in
      // view instead of being moved to the end.
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        element?.contains(field) &&
        field.matches('input, textarea, select')
      )
        field.scrollIntoView({ block: 'nearest' });
      else element?.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, revision]);
  function onScroll() {
    const element = transcriptRef.current;
    if (!element) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (following.current) setHasNew(false);
  }
  function jumpToLatest() {
    following.current = true;
    setHasNew(false);
    const element = transcriptRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
  }
  return { transcriptRef, onScroll, hasNew, jumpToLatest };
}
