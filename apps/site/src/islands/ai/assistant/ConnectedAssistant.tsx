import { useState } from 'react';
import { AssistantExperience } from './AssistantExperience';
import { createHttpAssistantAdapter } from './http-adapter';
import { initialAssistantState } from './state';
export function ConnectedAssistant({
  baseUrl,
  initialOpen = false,
}: { baseUrl?: string; initialOpen?: boolean }) {
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
      capabilities={{ history: false, inquiries: false }}
    />
  );
}
