import { useEffect, useRef, useState } from 'react';

/**
 * `anchor`: selectors tried in order for where the visitor left the
 * conversation. The first time it is found while open, the transcript starts
 * there instead of at the end; after that the visitor's own scrolling decides.
 */
export function useChatViewport(open: boolean, revision: string, anchor?: readonly string[]) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const previous = useRef(revision);
  const anchored = useRef<readonly string[] | undefined>(undefined);
  const wasOpen = useRef(open);
  useEffect(() => {
    const changed = previous.current !== revision;
    previous.current = revision;
    const reopened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    // The transcript mounts afresh when the panel opens again: start at the end.
    if (reopened) following.current = true;
    if (anchor?.length && anchored.current !== anchor) {
      const frame = requestAnimationFrame(() => {
        const element = transcriptRef.current;
        const target = anchor
          .map((selector) => element?.querySelector<HTMLElement>(selector))
          .find(Boolean);
        if (!element || !target) return;
        anchored.current = anchor;
        // Scroll the transcript only; the page behind it stays where it is.
        element.scrollTo({
          top:
            element.scrollTop +
            target.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            8,
          behavior: 'auto',
        });
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      });
      return () => cancelAnimationFrame(frame);
    }
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
  }, [open, revision, anchor]);
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
