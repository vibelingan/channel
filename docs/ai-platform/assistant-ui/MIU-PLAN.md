# 官网助手前端实施计划

当前进度更新：[产品查询与比较增量](PRODUCT-SLICE-DELIVERY.md) 已完成本地前后端接线，真实模型及生产目录待验收；下文前端独立阶段的限制属于历史范围，不限制已获批准的后端开发。

上一轮：[提问与停止前后端闭环](CHAT-SLICE-DELIVERY.md) 已完成。本文保留前一轮设计／计划，原模块的其余内容仍待实施；历史恢复由用户暂缓。

> 执行方式：本会话逐项实现和检查，不派发其他任务。沿用原 MIU 11 的编号；本轮已完成下列前端范围；原 MIU 11 的真实后端／生产 gate 尚未完成。

**Goal:** 把 29 屏设计落到复用现有视觉的实际 React 组件和前端状态，明天可替换 adapter 接后端。
**Architecture:** 共用聊天外观／输入／滚动行为，官网业务状态和组件单独拥有；模型、数据库和会话授权保留服务器。独立 Vite 入口仅开发预览，不新增 Astro 公开路由。
**Tech Stack:** 现有 Astro 6、React 19、Tailwind 4、TypeScript、node:test、Playwright，无新增依赖。
**Spec:** [DESIGN.md](DESIGN.md)、[后端实施顺序](BACKEND-MIUS.md)、[29 屏](screens.json)，以及现有 MIU_BREAKDOWN 的 11a–11f。

## 全局限制和复核重点

- 仅前端和设计；不改 BFF、worker、engine、DB 或 ai-contracts，不调用真实模型或邮件。
- 沿用网站 token、面板及路由；不修改其他工作树的文件，不整合未批准的其他分支。
- 重复／晚到事件、假停止、保存结果未知、中文 IME、上滚被拉回这五类行为必须有直接断言。
- 普通咨询、越界与单次失败不锁死输入；模拟模式总有明显标识，询盘同意默认关闭。
- 先推本设计和计划，再实现；每个可验证单元完成后提交推送，UI E2E 证明实际组件，不把 HTML 原型当产品。

## MIU 11c：前端状态和 IO 边界

**Files:** 新建 `apps/site/src/islands/ai/assistant/model.ts`、`state.ts`、`state.test.ts`。
**Interfaces:** `reduceAssistant(state, action): AssistantState`；TurnRequest／TurnEvent／AssistantAdapter 见 DESIGN。状态不持有凭据，外部 IO 不在 reducer 中。

- [x] 红：当前／旧 turn 隔离、重复序号、取消未确认、停止与 final 竞争、同一 key 重试保留文本。
- [x] 实现：不可变 reducer，身份和终态先判断再改消息。
- [x] 绿：node:test 直接执行状态转移；定向移除旧 turn／重复序号／终态 guard，测试必须命中预期断言。
- [x] 复核后提交推送；这不代表 SSE 后端已实现。

## MIU 11a／11b／11d：组件、键盘和安全文本

**Files:** 新建 `apps/site/src/components/chat/ChatPanel.tsx`、`ChatComposer.tsx`、`useChatViewport.ts`、`public-link.ts`；官网 `AssistantExperience.tsx`、`AssistantMessages.tsx`、`useAssistantSession.ts`。有限调整现有 `AssistantWidget.tsx` 复用外壳，保留其现有传输行为。
**Interfaces:** Panel 只收 open/onOpenChange/children/headerActions；Composer 收 value/onChange/onSend/onStop/disabled；viewport 只拥有 DOM 滚动。官网 hook 返回 state 和显式动作。

- [x] 实现同一 token 和品牌外壳；消息原样文本，不使用 raw HTML；安全来源链接。
- [x] 实现 Enter／Shift+Enter／IME、Escape 和焦点恢复；收起不调用新 adapter.stop。
- [x] 实现独立 async generation，卸载清理；过期 finally 不释放新任务的 busy。
- [x] 复核 hook、TypeScript 和公共职责；浏览器中验证 DOM、输入和旧页面外观后提交。

## MIU 11e：询盘核对及结果事实

**Files:** `InquiryReview.tsx`、`inquiry.ts`、`inquiry.test.ts`，复用 hook 的 adapter。
**Interfaces:** `validateInquiry(draft)` 返回字段错误；submission key 和冻结内容由 hook 固定；Receipt 表示已保存事实，不表示发邮件。

- [x] 红：缺联系方式／同意不得提交，错误保留字段，saving／unknown 不能换 key 或改内容，普通提问不保存。
- [x] 实现可访问表单、首错误焦点、保存未知与原提交核对、返回聊天不丢草案。
- [x] 验证模拟连续旅程后提交；明天的后端保存仍是独立验收。

## MIU 11：开发预览、完整交互验收与后端交接

**Files:** `apps/site/assistant-preview.html`、`assistant-preview.vite.ts`、`islands/ai/preview/*`、`playwright.assistant.config.ts`、`tests/assistant-ui/*.spec.ts`、本目录验证与交付记录。
**Interfaces:** 预览直接挂载同一 AssistantExperience；模拟 adapter 没有 fetch，不放进真实 Widget。29 状态通过同一组件数据表达，不另写演示组件。

- [x] 实现 29 状态查看，以及提问／停止／重连／询盘／历史连续旅程。
- [x] 浏览器覆盖桌面与手机、IME、滚动、重试身份、晚到事件、结果未知／确认；捕获 pageerror 和非本地 API 请求。
- [x] 验证 Astro build、既有 Widget／路由测试和类型检查；构建不新增预览页面，不载入模拟 adapter。
- [x] 两轮自审和必要修正，更新状态／证据／已实现和后端待办，提交推送。后端实现按 DESIGN 的 MIU 5f／6／7／4／5a／8 继续。

## 技术取舍与验证解释

原风险形状为 `setStatus('unavailable')` 处理所有单次错误，以及拼接任何 token 后自动拉到底部。前者把一次答不了变成整台助手不可用，后者打断阅读。新状态用当前 turn 的可恢复错误，新的滚动钩子以滚动位置决定跟随，不据长度猜用户意图。

浏览器 DOM／键盘／滚动由实际浏览器验证；状态和询盘规则用行为测试；生产授权、取消终态、幂等和真实模型只列设计与下一次 MIU，不用本轮模拟宣称通过。公共组件留在 site 内，尚无第二个产品消费者时不建立新共享包。

## 留到下一次的真实接线

下面没有在本轮实施，不受上面前端勾选状态影响。

- [ ] MIU 5f：服务端协议版本、运行归属及严格解码。
- [ ] MIU 6a／6b／7：真实状态、历史、分页及断流恢复。
- [ ] MIU 6c／5d：运行级取消及确认终态。
- [ ] MIU 4／5a：现有引擎上的有界公开产品工具与新 profile。
- [ ] MIU 8a／6d：复用正式询盘／SG1.2，接幂等保存与结果核对。
- [ ] MIU 11c／11e：真实 adapter 和原路由灰度，再做真服务 E2E。
