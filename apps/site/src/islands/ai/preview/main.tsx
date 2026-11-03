import { createRoot } from 'react-dom/client';
import '../../../styles/global.css';
import { AssistantWorkbench } from './AssistantWorkbench';
const root = document.getElementById('assistant-preview');
if (!root) throw new Error('Preview mount is missing');
createRoot(root).render(<AssistantWorkbench />);
