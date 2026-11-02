import { useState } from 'react';
import { AssistantExperience } from './AssistantExperience';
import { createHttpAssistantAdapter } from './http-adapter';
import { sessionAssistantPersistence } from './persistence';
import { initialAssistantState } from './state';
export function ConnectedAssistant({
  baseUrl,
  initialOpen = false,
  inquiries = import.meta.env.PUBLIC_AI_INQUIRIES === '1',
}: { baseUrl?: string; initialOpen?: boolean; inquiries?: boolean }) {
  // One record per tab, site and business: a refresh or same-tab page change
  // continues the conversation; a new tab starts its own.
  const [persistence] = useState(() =>
    sessionAssistantPersistence(
      `${typeof location === 'undefined' ? 'server' : location.host}:website_sales`,
    ),
  );
  const [adapter] = useState(() =>
    createHttpAssistantAdapter(
      baseUrl ?? import.meta.env.PUBLIC_AI_API_BASE_URL ?? '',
      fetch,
      persistence,
    ),
  );
  const [seed] = useState(() => ({
    state: { ...initialAssistantState('website-chat'), open: initialOpen },
    persistence,
  }));
  return (
    <AssistantExperience
      adapter={adapter}
      seed={seed}
      capabilities={{ history: false, inquiries }}
    />
  );
}
