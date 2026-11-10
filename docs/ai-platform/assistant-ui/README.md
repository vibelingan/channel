# 官网助手前端与后端交接

> 2026-11-10 当前评审入口：[官网助手／Sales／Apollo统一设计与调查](../review-20261110/README.zh-CN.md)。下文带日期的结果保留为历史，不代表本轮已上线。

## 官网旧版回复显示热修复（2026-11-09）

用户原句 `Helo, what does your company provide` 已在真实 v1 接口复现：5,853 ms 返回一个非空 `final`，没有 `token`。用户 Chrome 原标签页显示省略号，但输入框已经解锁。旧 `AssistantWidget` 收到 `final` 只恢复输入，没有把 `final.text` 写进回答，因此不是这条请求仍在排队，也不是据此需要再次充值。

从已有 `9b1d2357` 修复中只回移最终正文处理：最终文本覆盖同一条回答；空最终文本保留已收到正文，无正文时说明无法回答。等待时显示带文字的 Thinking；完整新 UI 仍保留在独立分支，没有在这次紧急修复中整合。模型、数据库连接及 Hermes Agent 不改。

`scripts/verify-assistant-final-delivery.mjs` 运行真实构建的官网组件，只在本地回归中替代 IO：修复前桌面/手机两项 final-only 均失败，token+final 两项通过；修复后四项通过。该检查已接到正常发布之前的 CI，失败截图和结果会随原 artifact 保存。本地回归不代替发布后官网真实问答。

同时复用 `a77aa00e` 的发布检查修复：离线函数检查只用合成 Sales 身份和假凭据，不再继承真实启用标志后因缺凭据中断。正式询盘/Sales 安全开关保持原值，不为发布而开启它们；没有发送邮件。

### 已发布与真实官网复验

代码 `0b9a78f635ab4dba43844debdb788869fda7598d` 已推送热修复分支 `fix/assistant-final-live-20261109`，并快进到 `test`。本项目的 `test` 实际服务正式域名，不能称作隔离测试站。[Deploy Test 42582880958](https://github.com/vibelingan/channel/actions/runs/42582880958) 的部署、托管读回及后台冒烟作业成功；受控网站交付 `site-42582880958-1` 在 2026-11-09 08:50:10 UTC 接受，产物摘要为 `52aa73fa27c1ae99d3c2b46c3373277429dd7ebe488a6c1ebc1560e3a6f33987`。官网脚本从 `AssistantWidget.D4-MbCGW.js` 切换为 `AssistantWidget.8z_zThga.js`。

发布后直接在 `https://supplychainsai.com/` 使用真实模型验收，没有替代 API、没有本地数据库、没有提交询盘或发送邮件：

| 实际问题／环境 | 看到的结果 | 发送到完整回复 |
| --- | --- | --- |
| 桌面：用户原句 `Helo, what does your company provide` | 显示完整答复，输入恢复 | 5,470 ms |
| 同一会话：OEM／ODM 服务 | 返回公司服务及资料来源 | 10,070 ms |
| 同一会话：300 个降噪耳机作礼品 | 返回产品方向、目录标题和后续问题 | 7,940 ms |
| 同一会话：东京天气 | 明确说明无法执行，引导回产品与服务 | 3,424 ms |
| 手机尺寸 390×844：用户原句 | 显示完整答复，无空泡泡 | 6,135 ms |

五项均在发送后 22–41 ms 观察到带文字的 Thinking 提示。手机为 Chromium 尺寸模拟，不代表实际 iPhone 验收。另在用户原 Chrome 官网标签页刷新、重新输入原句，已实际看到等待提示和最终正文。结果和截图保存在本机交付目录 `~/.codex/visualizations/2026/10/13/01a13457-d131-7392-9655-fd2540476b88/live-chat-fix-20261109/`。

本次检查证明回复能够显示，未把产品匹配和商业条款正确性一起宣布验收。现用旧版把产品目录作为文字展示；完整新版卡片、询盘交互和流式体验仍在 `fix/assistant-feedback-20261109` 等既有工作中，不能以这次热修复替代其官网验收。

**发布开关记录：** 发布前环境变量曾为 `PUBLIC_AI_CHAT_V2=1`，但旧站实际运行 v1。为只修现有入口、避免顺带启用尚未验收的完整新版，这次明确改为 `0` 并读回确认。`PUBLIC_AI_INQUIRIES`、`SALES_SOURCE_CAPTURE_ENABLED`、`SALES_SOURCE_DELIVERY_ENABLED` 均保留 `0`。整合新版时再明确启用 V2；本轮没有重新发布 AI CloudRun、重启 Hermes Agent 或改变发送权限。

**OrbStack 与验收区分：** 本会话较早的 Apollo 回归曾使用临时 MySQL 容器，已经删除；它不是官网聊天验收。OrbStack 目前还有其他项目的容器，本轮故障处理没有启动或关闭它，尚未确认是谁启动应用本身。此前本地 UI 检查不能当作官网真实验收，这次已补齐真实网站证据。

**审阅与表述检查：** 核对了 `AssistantWidget.tsx`、`verify-assistant-final-delivery.mjs`、`ci.yml`、`deploy-test.yml` 及网站发布回执，独立审阅未发现阻断问题。将“接口已接通”改为具体可查的“原问题在官网 5,470 ms 显示答案”，保留手机模拟、旧版入口和新版未验收的边界。

2026-11-09 后续规划：[统一待办入口](../BACKLOG.zh-CN.md)负责状态、回评时机与完成依据；[真实阶段与连续输出设计](../STREAMING-DESIGN.zh-CN.md)说明后端还需怎样调整。本轮只补设计和待办，连续输出在 Resend／Apollo 稳定后再评审实施，不将下面的模拟界面测试当成真实模型连续输出验收。

## 即时反馈与界面调整（2026-11-09）

本轮基于 Claude 的 `feat/sales-assistant@d0cbe5e8`，在独立分支 `fix/assistant-feedback-20261109` 修改；没有合并或发布，也没有修改其他工作树的草稿。

- 发送后先在浏览器显示 **Thinking…** 和一句说明，再等待网络。旧版和新版都不再把空回答渲染成一个 `…` 气泡。
- 公司资料、产品查询和组织答案的提示只由收到的工具事件切换。正文按收到的片段追加在同一条回答里，并显示细光标；没有用计时器模拟阶段或把整段文字伪装成逐字输出。
- 面板、消息、输入区沿用现有品牌色和组件，调整间距、圆角、焦点和短动画。开启系统“减少动态效果”时关闭新增动画。产品横向卡片与聊天内询盘流程继续复用。
- 断线后保留恢复入口；关闭面板仅隐藏，不取消进行中的回答。Legacy 仍在提交已受理后才显示 Stop；取消接口返回 `cancelled:true` 表示取消请求被接收，不证明模型已经完全终止。新版继续保留原有的终态确认流程。

本次实际调用了专用图像生成工具来探索四种界面状态。当前工具没有型号选择字段，也没有提供精确型号回执，因此不能把这次调用声称为已指定 GPT Image 2.6。图稿只是视觉参考，里面的示例产品参数不作为商品事实。以后优先使用最新且可核实的图像模型的要求，已写入本机全局 `~/.codex/AGENTS.md`；不宣称同步了整个账号或其他电脑。

本机预览仍用下方原命令。`/assistant-preview.html` 展示新版实际组件；`/assistant-legacy-preview.html` 是旧版传输的专用测试夹具，只有测试拦截接口时才返回模拟回答。两者都不进入正式站点构建。

验证：52 项单元/组件测试通过；桌面和 Chromium 手机模拟共 110 项浏览器测试通过，覆盖发送后即时反馈、工具状态、同一气泡逐段增长、断线恢复、停止确认、产品轮播与询盘提交。四处状态门禁的缺陷注入均能使测试失败；类型检查、静态构建和构建后真实路由检查通过。浏览器接口使用模拟 IO，不能代替线上模型、实际手机和部署后验收。最后仅调整了等待提示的文字及测试名称，行为代码未变。

**真实后端的限制：** 独立复查发现，当前 VibeKB 模型请求仍是 `stream:false`；Worker 会等完整回答通过来源校验，再把整段正文作为一个事件保存。因此这里只完成了客户端接收片段的能力，真实模型正文连续输出尚未完成。旧版接口还会跳过 `tool.progress`，真实连接中只显示 Thinking；V2 才能显示真实查询阶段。本轮没有改这些后端行为。以后要实现真正连续输出，必须一起调整模型请求、内容校验和事件传递，不能用前端打字动画或拆成几百次数据库写入冒充。证据位于 `packages/ai-engine-vibekb/src/index.ts` 的模型调用、`apps/ai-worker/src/worker.ts` 的 `approvedEvents` 与 `apps/ai-bff/src/server.ts` 的 `streamEvents`。

截图保存在 `output/assistant-ui/screens/`；设计图保存在 `output/assistant-feedback-20261109/imagegen-visual-direction.png`。独立 CI 会把浏览器截图和结果作为该次 SHA 的 artifact 留存。审阅发现并修正了“断线恢复按钮被隐藏”和“提交受理前取消存在竞态”两处问题。

写作核对：本轮阅读 `humanizer/SKILL.md` 与 `references/plain-technical-writing.md`，并核对本页、`AssistantWidget.tsx`、`AssistantExperience.tsx` 和浏览器断言。将“接通流式接口”改为“收到片段后在同一条回答追加”；只有实际 DOM 增长测试通过才说明界面连续输出。

## 开发状态与入口（2026-11-03 历史记录）

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
