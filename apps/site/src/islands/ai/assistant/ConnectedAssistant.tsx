import { useState } from 'react';
import { AssistantExperience } from './AssistantExperience';
import { createHttpAssistantAdapter } from './http-adapter';
import { initialAssistantState } from './state';
export function ConnectedAssistant({
  baseUrl,
  initialOpen = false,
  inquiries = import.meta.env.PUBLIC_AI_INQUIRIES === '1',
}: { baseUrl?: string; initialOpen?: boolean; inquiries?: boolean }) {
  const [adapter] = useState(() =>
    createHttpAssistantAdapter(baseUrl ?? import.meta.env.PUBLIC_AI_API_BASE_URL ?? ''),
  );
  const [seed] = useState(() => ({
    state: { ...initialAssistantState('website-chat'), open: initialOpen },
  }));
  return (
    <AssistantExperience
      adapter={adapter}
      seed={seed}
      capabilities={{ history: false, inquiries }}
    />
  );
}
