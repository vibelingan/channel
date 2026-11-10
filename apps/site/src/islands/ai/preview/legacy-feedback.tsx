import { createRoot } from 'react-dom/client';
import '../../../styles/global.css';
import { LegacyAssistantWidget } from '../AssistantWidget';

const root = document.getElementById('assistant-legacy-feedback');
if (!root) throw new Error('Legacy feedback preview mount is missing');

// The browser spec intercepts this relative API path. No real provider is called.
createRoot(root).render(
  <main className="min-h-screen bg-surface-alt p-8 text-ink">
    <h1 className="text-xl font-semibold">Assistant feedback fixture</h1>
    <p className="mt-2 text-sm text-ink-muted">
      Local component test. No live model or email service.
    </p>
    <LegacyAssistantWidget apiBase="/api/ai-test" />
  </main>,
);
