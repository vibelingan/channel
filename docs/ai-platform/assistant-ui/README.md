# 官网助手前端与后端交接

## 当前状态与入口（2026-11-03）

- **当前设计与执行顺序：** [第二轮设计（定稿）](ROUND2-DESIGN.md)。MIU 12–20 在整合分支 `feat/sales-assistant` 上实施，剩余工作统一列在其 §8。
- **本轮之外的规划：** [会话生命周期、防护、隐私、可复用内核与 Backlog](ROADMAP.md)（记录按价值保存、防护层、隐私说明入口、做成可复用产品的方案、现在／下一步／以后）。
- 已有能力：真实 DeepSeek 与 VibeKB 问答、产品推荐／比较、多轮产品上下文、停止与恢复、确认询盘统一保存并交给 Hermes 自动任务；没有部署官网，没有发送邮件。
- 原始设计与 MIU 记录：[设计](DESIGN.md)、[前端 MIU](MIU-PLAN.md)、[后端 MIU](BACKEND-MIUS.md)、[真实模型实现说明](REAL-CHAT-IMPLEMENTATION.md)、[29 个状态](screens.json)。
- 操作说明：[真实运行步骤](REAL-CHAT-SETUP.zh-CN.md)、[给老板的 Resend 操作与安全交接步骤](RESEND-OWNER-SETUP.zh-CN.md)、[Resend 客户设置](RESEND-CUSTOMER-SETUP.md)。
- 逐轮计划、交付记录和验证 JSON 已归档到 tag [`archive/process-evidence-2026-11-02`](https://github.com/vibelingan/channel/tree/archive/process-evidence-2026-11-02/docs/ai-platform/assistant-ui)。取回：`git show archive/process-evidence-2026-11-02:docs/ai-platform/assistant-ui/<file>`。缺陷注入脚本把结果写到 `output/`（不提交）。

## 打开实际组件

在本分支根目录执行：

```sh
pnpm --filter @vibelingan-channel/site dev:assistant-preview --port 62058
```

打开 `http://127.0.0.1:62058/assistant-preview.html`。状态选择器用于查看各屏；选择后点 Start this journey，再从欢迎页输入问题，能连续体验停止结果未知、同一次回答恢复、询盘核对与原提交核对等流程。手机尺寸下先收起助手再切换预览状态。

这是实际产品组件与模拟 IO 的组合，不是已经上线的聊天服务。默认正式网站保留原传输行为；新接线用 `PUBLIC_AI_CHAT_V2=1` 显式启用。本机前后端联调入口为 `http://127.0.0.1:62058/assistant-chat.html`，此命令仍使用测试引擎；真实模型联调另见 [真实运行步骤](REAL-CHAT-SETUP.zh-CN.md)，不能把两个入口混为一谈。预览入口不会进入 Astro 构建。

**在真实整站上试用（MIU 18 起）：**

1. 先启动本机运行时（测试引擎、隔离的本地库、本机产品接口）：

   ```sh
   CHAT_TEST_DATABASE_URL=postgres://ai:ai@127.0.0.1:55432/chat_test ASSISTANT_SALES_SOURCE_ROOT=$PWD pnpm --filter @vibelingan-channel/ai-worker exec tsx ../../scripts/assistant-chat-local.ts
   ```

2. 再启动真实 Astro 网站：

   ```sh
   pnpm --filter @vibelingan-channel/site dev:assistant-site
   ```

3. 打开 `http://127.0.0.1:62059/`。

在这里点产品卡的 “View product” 会进入真实产品详情页，聊天接着用；产品详情固定读本机测试产品接口。

## 重跑检查

```sh
pnpm --filter @vibelingan-channel/site typecheck
pnpm --filter @vibelingan-channel/site test
pnpm exec tsc -p tsconfig.assistant-e2e.json
node scripts/verify-assistant-state-guards.mjs
pnpm exec playwright test --config playwright.assistant.config.ts
pnpm --filter @vibelingan-channel/site seo:fixture /tmp/assistant-seo.json
SEO_CATALOG_SNAPSHOT=/tmp/assistant-seo.json pnpm --filter @vibelingan-channel/site build
node scripts/verify-assistant-ui-build.mjs
```

独立 CI 在本分支代码、场景或测试变化时自动执行。浏览器覆盖桌面和 Chromium 手机模拟尺寸；实际 iPhone 键盘、屏幕阅读器和线上代理行为还需要后续实机／部署验收。截图和机器结果保存在本地 `output/assistant-ui/`，远端检查的同名 artifact 包含该次运行的证据。
