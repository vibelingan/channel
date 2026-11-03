# 官网助手第二轮：并行验证交接（给 Codex）

2026-11-03。负责人请 Claude 和 Codex 各自独立验证第二轮（MIU 12–20），结果交回负责人。下面只交代事实和边界，验证思路请按你自己的判断来，不必照 Claude 的测试走。

## 代码在哪里

- 仓库 `vibelingan/channel`，分支 `feat/sales-assistant`。请在你自己的 checkout 或 worktree 里工作，不要动 `/Users/nina/projects/channel-integration`（Claude 正在用）。
- 设计与记录：`docs/ai-platform/assistant-ui/ROUND2-DESIGN.md`（§15 是每个 MIU 的实现记录、必测项与测试的对应、未验证项），`ROADMAP.md`（§5.6 寒暄边界，§7 发布顺序，§8 负责人决定）。
- 本轮主要提交：`7f8dc4a2`（需求摘要、输入预算、用量、追问建议）、`404d2047`（整站测试与七道门禁缺陷注入）、`0318d9e9`（文档），以及之后“追问短标签、空转窗口改 10 分钟、产品页启动按钮提示”的提交。

## 做了什么（一句话一项）

- MIU 12–18：产品卡最多 5 张可翻、同标签页跳产品页并恢复对话、询盘核对卡（改需求撤销同意、同一提交键防重复）、跨页恢复、寒暄规则层（不调用模型）。
- MIU 19：每个会话一份需求摘要（推测不能覆盖访客原话），给模型的输入按优先级裁剪，单次 16000、单问题 32000 估算 token，逐次记录用量到 `ai_runs.usage`。
- MIU 15：每个回答最多 3 条追问建议，按钮显示短标签、发送完整原话；输入框有字时只追加不发送。
- MIU 20：真实 Astro 站点的整站路径（电脑和手机），以及 `scripts/assistant-defect-injection.mjs` 七道门禁的缺陷注入（8 个补丁全部被测试抓到）。

## 本机怎么跑

- PostgreSQL：`channel-ai-postgres` 容器，`postgres://ai:ai@127.0.0.1:55432/<库>`。
- AI 包：`DATABASE_URL=... pnpm test:ai`；官网：`pnpm --filter @vibelingan-channel/site test`。
- 浏览器三条线：`playwright.assistant.config.ts`（组件旅程）、`playwright.assistant-chat.config.ts`（真 BFF＋worker＋本机目录和 intake，需要 `ASSISTANT_SALES_SOURCE_ROOT=$PWD CHAT_TEST_DATABASE_URL=...`）、`playwright.assistant-site.config.ts`（真实 Astro 站点）。
- 真实模型：`scripts/assistant-real-*.mts` 通过 SSH 调用 Hermes 主机上现有的 TokenHub 模型和 VibeKB MCP，密钥留在主机上。用法见 `REAL-CHAT-SETUP.zh-CN.md`。

## 线上现状（Claude 2026-11-03 只读核对，请你也独立确认）

1. 官网的新聊天开关 `PUBLIC_AI_CHAT_V2` 没有打开，访客看到的是旧组件；它调用的 `ai-bff` CloudRun 地址目前请求超时。
2. `Deploy AI CloudRun` 工作流只支持 `AI_ENGINE_ID=anythingllm`。第二轮的需求摘要、建议和预算都在 `vibekb` 引擎里，生产上还缺：模型服务密钥、CloudRun 能访问的 VibeKB MCP HTTPS 入口、询盘 intake 的地址和专用令牌，以及工作流对这些设置的支持。
3. 线上 `public-api` 跑的是 `dc3af64b`，它只在 `feat/seo-foundation` 上，不在 `test` 上。这个分支比 `test` 多 79 个提交；直接把本分支部署到 `test` 会把它的线上函数换回旧版本。和本分支试合并只有两个文件冲突：`apps/functions/public-api/src/index.ts` 和 `packages/db/package.json`。

## Claude 没能验证的部分（你可以优先看）

- 真实模型能否稳定按格式给出 `need`、`suggestions`、`must`，以及 TokenHub 是否在响应里返回 `usage`。如果不返回，用量会标成“估算”。
- 真机 iPhone Safari：产品卡横滑、键盘弹出后输入框和发送按钮是否可见、启动按钮的提示动效。
- 部署之后：CloudBase 里真实的 `oemProjects` 记录、Sales 的登记和投递，以及 Hermes 侧 Sales 待审核成果的读回。
- 你认为设计本身有问题的地方，例如寒暄边界、预算数字、追问按钮显示短标签后可能“替访客说话”的风险。

## 边界

- 不写生产：不推 `test` 或 `main`，不打部署标签，不改 GitHub 变量或密钥，不改 CloudBase 数据。需要时先请负责人批准。
- 不读、不打印、不输入任何令牌或密码；不发送真实邮件。合成询盘只用测试安装下的记录。
- Hermes 主机上的配置、机器人和服务都不改。

## 交回什么

一份结果清单交给负责人，每项写明：严重程度、复现步骤、看到的现象和预期、证据（命令输出、截图路径或提交）。“没问题”的项也简单列一下验证了什么，这样负责人能看出覆盖了哪些面。
