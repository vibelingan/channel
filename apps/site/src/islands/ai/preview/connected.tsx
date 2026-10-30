import { createRoot } from 'react-dom/client';
import '../../../styles/global.css';
import { ConnectedAssistant } from '../assistant/ConnectedAssistant';
const root = document.getElementById('assistant-chat');
if (!root) throw new Error('Missing mount');
createRoot(root).render(
  <main className="min-h-screen bg-surface-alt p-6 text-ink">
    <h1 className="text-xl font-semibold">官网助手 · 前后端联调</h1>
    <p className="mt-3 max-w-xl text-sm">
      真实 BFF、独立本地数据库和现有 worker 已连接。本页使用确定性测试引擎，尚不代表真实 AI
      模型效果。输入 slow 测试较长回答并停止；fail 测试单次失败后继续提问。邮件和正式询盘不启用。
    </p>
    <ConnectedAssistant baseUrl="" initialOpen />
  </main>,
);
