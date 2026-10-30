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
      模型效果。输入 headphones 查看通过公开 HTTP
      接口读取的样例产品，选择两款比较、核对当前资料；not sure 测试澄清，no matching
      测试无结果，catalog failure 测试查询失败，slow 测试停止。邮件、历史恢复和正式询盘不启用。
    </p>
    <ConnectedAssistant baseUrl="" initialOpen />
  </main>,
);
