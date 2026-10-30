# 官网助手前端与后端交接

2026-10-30 更新：[提问与停止的前后端闭环已实现](CHAT-SLICE-DELIVERY.md)，真实模型效果、产品工具、正式询盘和部署仍待后续验收。历史恢复由用户暂缓。沿用 2026-10-29 的 29 屏方向和官网现有视觉，没有修改原设计工作树里的文件。

- [交付与复核记录](DELIVERY.md)：完成什么、检查证据、发现和修正、明确未完成项。
- [设计](DESIGN.md)：现有代码缺口、组件分工、状态与系统边界。
- [前端 MIU](MIU-PLAN.md)：原 MIU 编号、文件、完成记录和下一次待办。
- [后端 MIU](BACKEND-MIUS.md)：按顺序接协议、恢复、停止、产品查询和正式询盘。
- [29 个状态](screens.json)：沿用原编号。
- [定向缺陷注入结果](STATE-GUARDS.json)：4 处 guard 移除后均被测试抓到，不代表完整安全或生产 E2E。

## 打开实际组件

在本分支根目录执行：

```sh
pnpm --filter @vibelingan-channel/site dev:assistant-preview --port 62058
```

打开 `http://127.0.0.1:62058/assistant-preview.html`。状态选择器用于查看各屏；选择后点 Start this journey，再从欢迎页输入问题，能连续体验停止结果未知、同一次回答恢复、询盘核对与原提交核对等流程。手机尺寸下先收起助手再切换预览状态。

这是实际产品组件与模拟 IO 的组合，不是已经上线的聊天服务。默认正式网站保留原传输行为；新接线用 `PUBLIC_AI_CHAT_V2=1` 显式启用。本机前后端联调入口为 `http://127.0.0.1:62058/assistant-chat.html`，当前使用测试引擎。预览入口不会进入 Astro 构建。

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
