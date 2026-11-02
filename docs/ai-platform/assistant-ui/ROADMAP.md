# 官网助手：会话生命周期、可复用内核与 Backlog（2026-11-02）

本文件记录本轮之外的规划和调研：聊天什么时候过期、回访访客能不能被记住、助手怎么做成能给下一个客户复用的产品，以及按“现在／全链路跑通后／以后”排好的 backlog。本轮正在实施的内容仍以 [ROUND2-DESIGN.md](ROUND2-DESIGN.md) 为准；这里的条目不改变它的顺序。

## 1. 模型是怎么“记住”上一句的

我们用的是 DeepSeek 的 chat-completions 接口，它是**无状态**的：模型服务那边没有 session，也不保存我们的对话。每次访客提一个新问题，worker 从我们自己的 PostgreSQL 取最近的消息（查 30 条，送最近 20 条，`packages/ai-store/src/store.ts`、`packages/ai-policy/src/index.ts` 的 `maxContextTurns`），连同系统规则和检索到的资料一起，作为一次全新的请求发过去。模型“记得”前文，只是因为我们每次都把前文重发了一遍。

所以：

- **会话 ID 是我们的，不是模型的。** `conversationId` 是我们库里的主键，用来找回这段对话的消息、运行状态和询盘。模型服务从来看不到它。
- **每个新问题都会调一次（或几次）模型。** 这是必须的，新问题需要新回答。
- **刷新页面不是新问题。** 刷新前问题已经发出、模型已经在生成，刷新后用原来的 idempotencyKey 去接同一个 run 的事件流，读的是已经在生成或已经生成好的结果，不会再调模型（MIU 17）。
- **缓存不是记忆。** DeepSeek 会自动把请求的公共前缀缓存在磁盘上，下次请求前缀完全相同时，这部分输入按缓存价计费（明显更便宜），不需要改代码；但它按“内容前缀”命中，与会话 ID 无关，尽力而为，过一段时间自动清掉。[DeepSeek context caching](https://deepseek.com/en/news/context-caching/)。OpenAI 的 prompt caching 同理，默认保留时间从几分钟到 24 小时不等，取决于模型和设置。[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md)。让缓存多命中的办法是：系统规则放最前且保持不变，历史按顺序追加，检索资料这种每次不同的内容放最后——当前 engine 已经是这个顺序。
- **有状态的接口也存在，但不省钱。** OpenAI 的 Responses API 可以用 `previous_response_id` 或 Conversations 对象把历史存在 OpenAI 那边，response 默认保存 30 天；但链上所有历史输入仍按输入 token 计费，只是少传数据，而且把对话绑在一家厂商上。[OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)。我们以自己的库为准，换模型不丢历史，这也是常见做法。

## 2. 会话什么时候过期

### 2.1 现在的行为（MIU 17 之后）

| 层 | 保存什么 | 多久 |
| --- | --- | --- |
| 浏览器标签页（sessionStorage） | 会话凭据、未完成的问题、未提交的询盘 | 关掉标签页就没了；刷新和同标签页跳转保留；新开标签页是新对话 |
| 会话凭据 | 证明“这个浏览器可以读这段对话” | 创建后 24 小时（`AI_CREDENTIAL_TTL_SECONDS`，固定期限，不随使用延长）；过期后页面显示“开始新对话” |
| 服务端 PostgreSQL | 全部消息、事件、运行记录 | **目前没有删除机制，一直保留** |
| 模型服务 | 无 | 每次请求结束就结束（缓存除外，见上） |

这基本就是你描述的规则：关掉网站就重新开始，刷新保持，开着不关也有 24 小时上限。

### 2.2 两处缺口

1. **服务端没有保留期限。** 匿名访客的聊天会一直留在库里。这不影响功能，但隐私政策需要写清楚保存多久，数据也不该无限增长。建议：没有提交询盘的匿名聊天保存 90 天后删除；提交了询盘的，询盘快照随 Sales 记录走，原聊天同样 90 天后删除。需要你定天数。
2. **24 小时是从创建算起的固定期限。** 极端情况下，聊到第 23 小时 59 分会被打断。建议改为“最后一次提问后 24 小时内有效，最长 7 天”。因为关标签页就会清掉，这个改动收益小，放到下一步。

### 2.3 业界怎么做

- **Intercom：** 没登录的访客，对话靠浏览器 cookie 保存；它的访客识别 cookie 保留 9 个月，会话 cookie 1 周。官方也提醒，共用电脑的下一个人能看到上一个人的对话，退出时要主动清掉。[Intercom 安装说明](https://developers.intercom.com/installing-intercom/web/installation.md)、[Intercom 隐私说明](https://www.intercom.com/legal/product-privacy-notice)。
- **Zendesk：** 默认跨访问保留匿名访客的对话；为共用浏览器提供 “Forget history” 选项，开启后每次都从新对话开始，效果和我们现在按标签页保存一样。[Zendesk 说明](https://support.zendesk.com/hc/en-us/articles/4531075858458)。

也就是说，两种做法业界都有：客服产品默认“记住这台设备”，对共用设备再提供“不记住”。我们现在是更保守的那一种。

## 3. 回访访客能不能被记住

### 3.1 能做到什么

| 方式 | 能做到 | 代价 |
| --- | --- | --- |
| 同一台设备、同一个浏览器（localStorage 或第一方 cookie） | 几天后回来，显示“继续上次的对话”；看得到之前推荐过的产品和已提交的询盘 | 共用电脑会被下一个人看到；隐私政策要写；清浏览器数据、换浏览器或用无痕窗口就没了 |
| 邮件链接（访客提交询盘后留了邮箱） | 换设备也能回到同一段对话 | 要发邮件（真实发信目前关闭）、要防止链接被转发后泄露 |
| 登录账号 | 完整历史 | 匿名 B2B 访客基本不会为了问问题去注册 |

“每个访客都能被认出来”是做不到的：清缓存、换设备、无痕窗口都会丢。但对真正有意向的买家，“同一设备记住一段时间＋提交询盘后用邮箱跟进”已经能覆盖大部分回访情况；询盘本身由 Sales 用邮件跟进。

### 3.2 建议

- **现在：** 不做。先把完整链路（聊天 → 询盘落盘 → Sales Agent 处理）跑通给客户看。
- **全链路跑通后：** 做“同一设备记住 N 天”。回来时不自动展开聊天，而是在启动按钮上提示“继续上次的对话”；访客可以选择继续或开始新对话；聊天里提供“忘记这段对话”。凭据仍然只存在浏览器里，服务器照旧校验，不在 URL、日志里出现。建议 N = 30 天，需要你定。
- **以后：** 邮件链接续聊、登录历史。

合规提醒：海外买家适用 GDPR/ePrivacy 一类规则。“访客自己要求的功能所必需的存储”一般不需要额外同意，“记住设备以便营销”则需要同意。具体措辞要按隐私政策确认，这里不作法律结论。

## 4. 做成可复用的 AI 客服产品

### 4.1 业界的共同做法

几家主流平台的说法不同，结构基本一致：

- **一个助手 = 一份配置。** 包括角色和规则、知识来源、启用哪些动作、安全限制、上线渠道。Salesforce Agentforce 的结构是 agent → topic（一类业务，带“什么时候用”的说明和规则）→ action（具体操作，可以是流程、代码或提示词模板）；topic 和 action 可以在多个 agent 之间复用。[Agentforce 组件概览](https://www.asagarwal.com/?p=31668)、[Agentforce 标准动作](https://developer.salesforce.com/agentforce-workshop/employee-agents/3-standard-actions)。
- **动作 = 有类型的工具。** 一个名字、一段给模型看的说明、一份 JSON Schema 输入、一个服务端处理程序，外加权限和确认规则。OpenAI function calling、GPT Actions（OpenAPI）、MCP tools 都是这个形状。
- **动作的界面按名字注册。** 服务端产生一个动作结果，前端按动作名找到对应的组件来渲染：assistant-ui 的 tool UI 按工具名注册 React 组件，执行逻辑在别处登记。[assistant-ui tool UI](https://www.assistant-ui.com/docs/guides/tool-ui)。OpenAI ChatKit 用 widget 在聊天里显示卡片、表单，用 action 让界面不经过用户消息就触发后端操作。[ChatKit 进阶集成](https://developers.openai.com/api/docs/guides/custom-chatkit)。MCP Apps 让 MCP 服务器返回在沙箱 iframe 里运行的界面，Claude、ChatGPT、VS Code 等都支持，不支持的宿主退回显示文字结果。[MCP Apps 概览](https://rits.shanghai.nyu.edu/ai/mcp-apps-interactive-uis-become-an-official-part-of-mcp)。
- **模型可替换。** 会话、记忆、安全规则在自己这边，模型只是其中一个可替换的环节。

你说的“通用的 Action Schema＋映射＋Engine Core＋按规则启用组件、编排成流程”，就是这个结构。方向没有问题。

### 4.2 我们已经有的通用部分

| 已有 | 位置 | 换一个行业还能用吗 |
| --- | --- | --- |
| 模型接口（engine port，可替换 DeepSeek／AnythingLLM 等） | `packages/ai-engine`、LLD-002 | 能 |
| 会话库：幂等提问、事件流续读、运行状态、人工接管 | `packages/ai-store`、LLD-001 | 能 |
| 安全策略档案（只说公开事实、不编价格、联系方式不进模型） | `packages/ai-policy` | 结构能，内容要按行业换 |
| 前后端合同 | `packages/ai-contracts` | 能 |
| 页面的会话层：发送、停止、续读、刷新恢复 | `apps/site/src/islands/ai/assistant` 的 session／adapter／persistence | 能 |
| 业务专用：销售提示词、产品查找与产品卡、询盘表单与 Sales 落盘 | engine 提示词、`catalog-*`、`InquiryReview`、`apps/functions/sales-integration` | 不能，这是“外贸销售”这个业务插件 |

现在的问题是：业务专用部分和通用部分写在同一批文件里，还没有一个“业务插件”的边界。

### 4.3 建议：先划边界，等第二个客户再抽成通用引擎

只有一个客户时就做通用引擎，猜错抽象的代价很高：第二个行业的需求往往和想象的不一样。业界常用的经验是“第三次再抽象”。我们的折中办法：

- **现在（本轮）：** 新写的东西沿着这条线放。MIU 16 的询盘卡作为消息流里的一种消息类型，由“消息类型 → 组件”渲染，不再是盖住聊天的整块页面；以后它就是“外贸销售”插件里的一个动作组件。不额外写通用框架。
- **全链路跑通后，与 Hermes H3 一起：** 写一份 ADR，定义两份合同，并把现有销售业务改成第一个用它们的插件：
  - `AssistantProfile`：id、角色与规则、语言、知识来源、启用的动作、策略、上下文预算、会话期限。
  - `ActionDefinition`：名字、给模型看的说明、输入 JSON Schema、确认规则（模型只能建议／必须由人确认）、服务端处理程序、幂等规则、结果 schema、前端组件名。
- **第二个行业来时：** 用这两份合同接入（例如法律咨询：利益冲突初筛、预约、材料清单），按需要修正合同。这时再决定是否用 MCP 承载服务端动作。对我们自己的聊天窗口，类型化的组件注册表比 MCP Apps 的 iframe 简单，MCP Apps 适合以后要把助手接进 ChatGPT／Claude 这类外部宿主的场景。

不变的原则：模型只能建议，确认、同意、提交这类业务动作由人点；动作的权限由服务器按配置决定，不信任模型的输出。

## 5. Backlog

### 5.1 现在（本轮，按顺序，不需要再决定）

MIU 16 → 18 → 13 → 14 → 19 → 15 → 20，一个 PR 合入 main，然后与 hermesinfra 做全链路联调。详见 [ROUND2-DESIGN.md](ROUND2-DESIGN.md) §9、§10。

### 5.2 全链路跑通后（先定方向，再排期）

| 编号 | 内容 | 需要你定 |
| --- | --- | --- |
| N1 | 服务端聊天保留期限与删除任务；隐私政策同步 | 天数（建议 90） |
| N2 | 同一设备“继续上次的对话”＋“忘记这段对话” | 做不做、记几天（建议 30） |
| N3 | 凭据改为“最后一次提问后 24 小时、最长 7 天” | 无，数字可调 |
| N4 | ADR：`AssistantProfile`＋`ActionDefinition`，把外贸销售改成第一个插件 | 同意 §4.3 的做法 |
| N5 | Hermes H3：Sales agent 登记进 agent 注册表 | 已确认，Sales 流程完成后做 |
| N6 | 用量与成本：按会话看模型调用次数、输入／缓存命中／输出 token | 无 |

### 5.3 以后

- 邮件链接续聊、登录用户历史。
- 多模态：访客上传产品照片或图纸，助手返回图片、对比表。需要文件存储、内容审核和支持图片的模型，做之前单独调研。
- 跨会话的长期客户记忆（同一买家的偏好）。需要明确的身份和同意，放在登录或邮件验证之后。
- Hermes H4：多层授权简化。
- 第二个行业接入，验证 N4 的合同。

## 6. 待你决定

1. 服务端聊天保存多久（N1，建议 90 天）。
2. 是否做同一设备回访续聊，记几天（N2，建议做、30 天）。
3. 可复用内核按 §4.3：现在只划边界，全链路跑通后写 ADR，第二个客户来时再抽通用引擎。

这三项都不影响本轮 MIU 16–20 的实施。
