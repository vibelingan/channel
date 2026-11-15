import { createRoot } from 'react-dom/client';
import '../../../styles/global.css';
import { ConnectedAssistant } from '../assistant/ConnectedAssistant';
// Stands in for /products/item/ in the connected test lane, so a product link
// from the chat can be followed in the same tab. The real product page mounts
// the same assistant through AssistantHost; `pnpm dev:assistant-site` runs it.
const root = document.getElementById('assistant-product');
if (!root) throw new Error('Missing mount');
const id = new URLSearchParams(location.search).get('id') ?? '';
createRoot(root).render(
  <>
    <main className="min-h-screen bg-white p-6 text-ink">
      <p className="text-xs text-ink-muted">Test stand-in for the product page</p>
      <h1 className="mt-2 text-2xl font-semibold" data-product-page={id}>
        Product {id}
      </h1>
    </main>
    <ConnectedAssistant baseUrl="" inquiries />
  </>,
);
