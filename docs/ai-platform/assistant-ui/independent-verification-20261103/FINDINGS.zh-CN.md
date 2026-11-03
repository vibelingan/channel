# 官网助手与 Agent：独立验证结果

2026-11-03。验证人：Codex。依据 `VERIFY-HANDOFF.zh-CN.md`，独立运行测试、补边界场景，并只读核对线上情况。

## 结论

本轮范围是第二轮 MIU 12–20。第三轮“多产品、通过对话整理联系人”等仅有设计，不作为本轮未完成缺陷。按 ROADMAP 最新决定，抵达产品页先收起聊天，用 Continue conversation 提示继续；本轮按这个最新决定验收。

本地的产品查找、横向卡片、追问、跨页继续聊天、聊天内确认询盘和防重复保存，已有可运行的实现。桌面和手机尺寸下的连接测试通过。

**当前不能按“完整真实链路验收通过”发布。** 有三处可复现的业务代码问题和一处测试配置问题；真实模型请求连续超时。手动补跑远端检查后，UI 成功，聊天 CI 在类型检查处失败；发布脚本也还没把 VibeKB 和询盘 intake 的新配置接进去。真实 CloudBase 保存到 Hermes 销售成果的这一段，本轮没有写入验证。

SEO 与 Agent 可以整合。两个文本冲突有明确的保留方式，真正要保护的是线上已运行的 SEO 版本。现在直接从 Agent 分支运行普通网站部署，会把这些新版本覆盖掉。

本轮只在独立 worktree 里验证。没有修业务代码、修改生产配置、写 CloudBase、发邮件、推 test/main 或合并两个功能分支。缺陷注入时临时破坏的源文件均已还原。

## 一、核对的版本和环境

| 对象 | 本轮核对结果 |
| --- | --- |
| 验证 checkout | `${VERIFY_ROOT}`，detached HEAD |
| Agent 分支 | `origin/feat/sales-assistant`，`004e534c27d2c7bdee01ed535ea853925bcf8774` |
| SEO 分支 | `origin/feat/seo-foundation`，`ba2a480dcadb1de89dadd0a49af9009d7acbcba8` |
| main | `b3d63ac14f0bd1fac700e9b7c403e61076cf1ba4` |
| test | `914438425aa5b12193707d34c146f90372aff94e` |
| 项目固定的 CI Node | 22.13.0；pnpm 11.5.0 |
| 本机另一个 Node | 25.6.1。仅用来定位版本差异，不能代替 Node 22 验收 |
| 本轮数据库 | 自建本地容器 `channel-assistant-verify-20261103`，仅绑定 `127.0.0.1:62691` |
| 真知识库 | 通过现有 SSH 配置及远端已存在的 relay 只读连接 VibeKB MCP |

开始、验证过程中及报告前重新 fetch；以上远端分支在本轮最后一次读取时没有变化。没有进入或修改 Claude 的 `${CLAUDE_HOME}/projects/channel-integration`，也没有改原 UI worktree 的文件。

交接里写的本地 55432 端口实际属于另一项目的 `rag_postgres`，本轮没有使用它。最初尝试旧测试容器时遇到认证失败，随后改用本轮自己创建的容器并重跑；该配置失败没有算成产品缺陷。

## 二、需要修复的代码问题

### F1 · P1：Node 22 的源码执行路径无法导入 JSON 解析器

位置：`packages/sales-contracts/src/canonical.ts:4`。

现状是直接导入 `jsonc-parser/lib/esm/main.js`。在项目固定的 Node 22.13.0 加 tsx 的路径下，启动时报：

```text
SyntaxError: The requested module 'jsonc-parser/lib/esm/main.js' does not provide an export named 'visit'
```

独立复现文件：`canonical-import.mts`。执行方式：

```sh
# 先把 PATH 指向 Node 22.13.0，然后在验证 checkout 运行
pnpm --filter @vibelingan-channel/ai-worker exec tsx ../../output/independent-verification/canonical-import.mts
```

同一个文件用 Node 25.6.1 加 tsx 执行，输出 `{"verify":true}`。Node 22 的整站测试也在本地 intake 启动阶段遇到同样错误，尚未到浏览器操作；官网测试中有 20 个测试文件因同一个导入错误失败。

预期：按仓库和 CI 声明的 Node 版本，询盘链路及受影响的后台测试应能启动。影响不局限于新聊天，因为公共数据库入口会引用这份解析器。

边界：Astro 打包已经成功；不能据此推断“所有打包后的生产服务都无法运行”。这是源码执行和测试启动路径的已证实问题。原改动用于避免函数打包后的 UMD 相对导入问题，修复时也必须保住那项检查，不能简单改回去后只测本机。

证据：[Node 22 最小复现](canonical-node22.txt)、[Node 25 对照](canonical-node25.txt)、[Node 22 整站启动失败](fullsite-tests.txt)、[官网失败索引](site-failures-index.txt)。

建议：同时解决源码运行和打包产物的导入兼容性，并在 Node 22 下重跑整站路径、官网测试及函数产物冷导入。本轮未改。

### F2 · P2：取消“全部定制”后，摘要仍保留旧 logo 要求

位置：`packages/ai-policy/src/need.ts:198–204`。

独立场景：

1. 访客说 `Please add our logo`，形成明确提出的 `logo` 定制项。
2. 访客接着说 `Cancel all customization; use standard packaging.`。
3. 给合并器传入正确的模型结果 `customization: []`。
4. 实际返回仍保留 `logo`，摘要版本也没有变化。

预期：明确取消全部定制后，旧 logo 项应被移除。当前保护要求“最后一条消息必须逐项提到旧值”，所以会挡住客户的整体取消。

这不是在指责模型理解错误：本复现已经给出正确的空列表，错误发生在系统合并规则。后续询盘和追问可能继续携带已取消的要求。

证据：独立复现源码（原验证目录中的 `edge-probes.mts`）、[结果](edge-probes.json)，case 为 `explicit_cancel_all_customization`。

建议：为整体取消或重置设计可验证的明确操作及对应原话依据，同时保留“模型推测不能覆盖访客明确要求”的保护。不能把所有空列表都直接当成取消。本轮未改。

### F3 · P2：模型返回截断结果时，有用量却没记账

位置：`packages/ai-engine-vibekb/src/index.ts:294–306`。

独立对照使用相同正文和 `usage={prompt_tokens:1000, completion_tokens:1200}`，仅改变 `finish_reason`：

| 服务商响应 | 实际系统事件 |
| --- | --- |
| `stop` | 正常产生 usage 事件，记录 1000 输入、1200 输出 |
| `length` | 抛出 `invalid_request`；没有 usage 事件 |

预期：正文因截断不能使用，也应保存服务商已返回的用量。现在先验证完成原因再返回 usage，造成这类失败请求没有用量记录。

影响：失败调用的统计会低估消耗。这里是受控响应复现，不是对本轮真实账单金额的断言。常见正常 `stop` 路径的用量测试仍通过。

证据：[独立复现结果](edge-probes.json)，比较 `provider_finish_stop` 与 `provider_finish_length`。

建议：将提取、保留用量与接收业务正文分开，补“截断、拒答或其他无效响应仍带 usage”的边界测试。本轮未改。

### F4 · P2：聊天 CI 在类型检查处失败，尚未执行 E2E

位置：`tsconfig.assistant-chat.json:5` 与 `tests/assistant-chat/connected.spec.ts:620–622`。

新增的横向卡片测试使用展开语法遍历 `HTMLCollection` 和 `NodeListOf<Element>`，而该测试配置只声明了 `ES2023`、`DOM`，没有 `DOM.Iterable`。

远端 [聊天运行 41621189754](https://github.com/vibelingan/channel/actions/runs/41621189754) 在 `Validate contracts and service types` 的第一个命令失败，错误为两条 TS2488。后续数据库与浏览器测试没有执行。最后的“没有可上传 artifact”是前面未到浏览器步骤的后果，不列为另一项业务缺陷。

本地固定 Node 22 同样复现：

```sh
pnpm exec tsc -p tsconfig.assistant-chat.json
```

只在命令行补充 `--lib ES2023,DOM,DOM.Iterable` 后，检查通过；没有改任何配置文件。这解释了为什么浏览器交互能通过而 CI 仍失败：浏览器执行这些集合遍历没有问题，但 TypeScript 的测试配置不完整。

证据：[本地类型错误](chat-typecheck-node22.txt)、[远端失败日志](ci-chat-failed.txt)、[临时参数对照](chat-typecheck-dom-iterable.txt)。建议补齐这份类型配置后重新跑整条聊天 CI。本轮未改。

## 三、发布前仍缺的验证和接线

### G1：真实知识库可读，真实模型没有完成回答

已实际调用 `VibeKbEngine.verifyKnowledge()`，返回：

```json
{"workspaceId":2,"sourceIds":["channelkb/vibekb/12"]}
```

这条路径实际通过 MCP 搜索、取文档并核对所属工作区和公开标签，使用的是 VibeKB。没有调用会写远端 relay 的 `install()`，没有改 Hermes 配置，也没有把远端密钥带回本机。

真实模型使用远端现有的 `deepseek/deepseek-v4-pro` 配置：

| 实际问题 | 结果 |
| --- | --- |
| 采购 500 副 ANC 耳机、德国市场、公司礼品、印 logo | 102.6 秒后 `unavailable`，没有模型正文 |
| 改 700 副、不要 logo、改礼盒包装 | 102.1 秒后 `unavailable`，没有模型正文 |
| 从同一主机直接向模型服务发送极小请求 | 30 秒超时 |

因此还不能验证真实模型是否稳定给出 `need`、`suggestions`、`must` 和服务商 usage。第二个问题没有成功的第一轮上下文，只能作为请求可用性的重复检查，不能算需求更新能力的真实验收。第三个原计划问题未完成，停止后没有继续重复耗时请求。

这些结果能把问题范围缩到现有模型请求路径，不能仅凭超时认定是密钥、额度、网关或模型本身的哪一个问题。

证据：[知识库回执](kb-probe.json)、[两次模型请求](real-engine-results.json)、[主机侧极小请求](provider-direct-probe.json)。

### G2：新分支没有自动触发检查；本轮已补跑手动测试

开始及复核时，两次查询 `feat/sales-assistant` 的 Actions 运行均为空；当前提交的 check-runs 为 0。随后已核对两条助手工作流只运行测试，不操作生产，手动对同一 SHA 补跑：

- UI：运行 `41621179523`。
- 聊天：运行 `41621189754`。

最终结果：UI [41621179523](https://github.com/vibelingan/channel/actions/runs/41621179523) 成功；聊天 [41621189754](https://github.com/vibelingan/channel/actions/runs/41621189754) 失败，见 F4。本次补跑不改变 push 触发规则，也不补上工作流尚未覆盖的场景。

- `assistant-chat.yml` 和 `assistant-ui.yml` 的 push 分支仍是 `main` 与旧的 `feat/website-assistant-ui-foundation`。
- PR 有触发规则。本轮没有开 PR，通过手动触发取得了上述当前 SHA 的两条结果。
- 聊天 CI 仍另取 `68bab6024488f58a29dd7d0eb0ceaeed103290c9` 作为 intake 源码，不能证明当前整合后的 intake 已被验证。
- 新增的 `playwright.assistant-site.config.ts` 没有加入这些助手 CI 命令。

预期：验收的当前提交与当前整合后的询盘实现，应有固定 Node 下的远端检查。现在不能把“代码推上去了”说成“远端检查通过”。

证据：[手动运行前的分支查询](remote-checks-final.json)、[手动运行前的提交检查](head-check-runs.json)、[手动补跑回执](ci-dispatch.json)、[UI 最终状态](ci-ui-final.json)、[聊天最终状态](ci-chat-final.json)，以及上述 workflow 源码。建议让实际提交和整合树进入自动检查，并加入整站路径。本轮没有改工作流或发起部署。

### G3：源码支持 VibeKB，但正式部署脚本没有传齐配置

这两件事要分开：真实 VibeKB 已存在且本轮可读；仓库的 CloudRun 发布入口仍沿用旧引擎的配置和检查。

`deploy-ai-cloudrun.yml` 仍调用 `probe-anythingllm.mjs`；`cloudrun-service-manifest.mjs` 没有把当前引擎所需的模型、VibeKB、intake 地址及专用授权配置传入运行服务。仅改 `AI_ENGINE_ID` 不足以发布第二轮能力。

这项与交接文档一致，属于已知发布缺口，本轮重新读代码确认。不是要求重新接 AnythingLLM。

### G4：生产联动和 iPhone 真机未验收

本轮没有写生产 `oemProjects`，没有登记或投递真实 Sales 任务，没有读回新的 Hermes 待审核邮件，也没有发真实邮件。本地 E2E 验证的是现有 intake 代码与测试存储的事务行为。

三个浏览器配置的 mobile 项实际使用 Chromium 的 iPhone 尺寸模拟；没有运行 iPhone Safari 真机。320/768 宽度及 360 高度的检查通过，但缩小视口不能证明 iOS 虚拟键盘、地址栏变化和系统手势已经通过。

## 四、实际通过和失败的检查

| 检查 | 本轮结果 | 能证明什么 |
| --- | --- | --- |
| `pnpm test:ai`，Node 22、本地 PostgreSQL | 405 通过，2 跳过 | 引擎、策略、store、BFF、worker 回归。含 103 项历史 AnythingLLM 适配器回归，不代表新链路使用它 |
| `ai-contracts` | 7 通过 | 消息和询盘格式检查 |
| 助手单元测试及路由、公共链接测试 | 45 通过 | 当前组件状态、请求适配器和链接边界 |
| intake 单元测试 | Node 22 和 25 各 3 通过 | intake 的专用凭据、已确认表单、测试安装规则；此文件不等于真实 DB 适配器启动 |
| 连接浏览器，Node 25 | 58 通过 | 真 BFF、worker、本地 PostgreSQL；模拟模型/产品目录，本地测试 intake；丢回执、同键恢复、跨页等 |
| 组件交互浏览器，Node 25 | 98 通过 | 组件状态及桌面、手机操作；停止、重试、改需求重新同意、表单留在聊天等 |
| 真实 Astro 本地页面，Node 25 | 4 通过，2 个桌面重复项按配置跳过 | 首页到产品页再到聊天内询盘，读回 1 条询盘、1 条来源登记和 1 条投递；这些 Channel 记录来自本地测试存储 |
| 同一整站路径，Node 22 | 启动失败 | F1；还没到浏览器交互 |
| 官网全包测试，Node 22 | 1207 通过，20 失败，1 跳过 | 20 个文件都可见同一解析器导入错误，不能报全包通过 |
| 全量根脚本测试，Node 22 | 1261 通过，3 失败 | 两项子进程超时；一项被 F1 提前挡住 |
| 上述两个超时文件单独串行重跑 | 25 通过 | 两项超时没有在单独运行时复现，不因此把最初全包结果改为通过 |
| AI 五个相关包类型检查、官网类型检查 | 通过 | 官网 0 错误、0 警告、13 提示；不是完整仓库类型检查的替代 |
| lint | 0 错误，1 警告 | 一个无效 biome suppression；未自动改源码 |
| Astro 构建，Node 22、本地 SEO 快照 | 通过 | 静态构建和产物生成，不证明线上数据与线上部署已验收 |
| AI 构建及运行镜像冷导入，Node 22 | 通过，整个命令退出 0 | BFF、worker 的真实 Docker runtime 阶段均完成冷导入；F1 不能扩大成打包后程序都无法运行 |
| 8 个缺陷注入 | 最终 8 个均被对应断言抓到 | 下文说明有效性复核和一次空白库重跑 |
| 真实 VibeKB MCP | 通过 | 工作区 2 的指定公开文档可读 |
| 真实模型 | 两次超时 | 尚未取得真实结构化回答 |
| 当前 SHA 的远端 UI CI | 成功，41621179523 | 现有 UI 工作流通过 |
| 当前 SHA 的远端聊天 CI | 失败，41621189754 | 类型检查的两条 TS2488，尚未执行后续 E2E，见 F4 |
| 聊天专用 TypeScript 检查，本地 Node 22 | 同样失败 | 仅命令行补 DOM.Iterable 后通过；没有改文件 |

Node 25 的官网全包复跑曾被会话中断，没有最终结果，不计为通过。第一次连接浏览器也被中断，表中只计随后完整跑完的 58 项。未把只跑到一半的输出当成成功。

主要日志：[AI](ai-tests-node22.txt)、[组件单元](assistant-unit-node22.txt)、[连接浏览器](connected-node25-complete.txt)、[组件浏览器](journeys-node25.txt)、[Astro 整站](fullsite-node25.txt)、[官网全包](site-tests.txt)、[根脚本](root-script-tests.txt)、[超时串行复跑](root-timeout-rerun.txt)、[类型检查](site-typecheck.txt)、[静态构建](build.txt)、[AI 构建](ai-build-node22.txt)、[运行镜像检查回执](runtime-build-receipt.json)。

人工看过整站手机保存回执和窄屏截图，输入框与发送按钮可见；短屏时正文区会很小。仍需 iPhone 真机确认，不把截图代替实际键盘测试。

## 五、缺陷注入有没有真正“测到测试”

本轮复用仓库的 8 个补丁，另写了只放在 output 的运行器：先运行未改代码的同一组测试，确认能通过；再施加补丁；逐条保留断言失败输出；最后还原源码。

最终全部能抓到：

| 故意破坏的保护 | 实际抓到的变化 |
| --- | --- |
| 产品最多 5 张 | 20 张不等于 5 张 |
| 询盘不确定后重试同一个键 | 单元检查键变化；浏览器读回 PREVIEW-002 而非原 PREVIEW-001 |
| 没会话凭据不能读历史 | 未授权读返回 200，而应为 401 |
| 明确的新数量不被旧推测覆盖 | 700 被退回 500，需求摘要断言失败 |
| 改需求后必须重新同意 | consent 保持 true，而应为 false |
| 每问题输入预算 | 多发了第 2 次请求，而应停在 1 次 |
| 测试身份不能靠公司名猜 | 普通公司测试询盘从 200 变成 503 |
| 刷新继续原回答的幂等键 | 同一回答被换成随机键 |

其中数量记忆的首次未改代码测试失败，原因与本轮复用的库中残留可消费任务有关；测试的 `processOne()` 会取队列里的任务，而不只取当前测试会话。换成新建空白本地数据库后，未改代码先通过，再破坏代码能稳定失败。这是测试运行隔离问题，不据此声称正常业务中的数量保护失效。

原脚本只判断“非零退出且看起来跑过测试”，没有未改代码的对照，也不保留断言输出。建议后续把本轮增加的对照、每个数据库案例的隔离和日志保存纳入正式脚本，避免把测试环境坏了误记为成功抓到缺陷。本轮没有修改正式脚本。

证据：[最终结果](defect-results-final.json)、运行器（原验证目录中的 `defect-injection-with-baseline.mjs`）、[首次库污染记录](defect-baseline-needs-fresh-db.txt)、[空白库数量对照](mutants/4a-baseline-1.txt)、[对应故障](mutants/4a-mutant-1.txt)。所有临时源文件修改已还原。缺陷注入会覆盖默认 Playwright 的结果文件；其中的故意失败应结合 mutants 日志看，完整正常交互通过的结果以独立的 58 项、98 项和整站日志为准。

## 六、线上情况与分支如何处理

本轮只读 HTTP 核对：

- `supplychainsai.com` 首页 200，实际加载旧的 `AssistantWidget.PvdNAv7f.js`，未看到第二轮组件启用。
- public-api `/api/health` 返回 200，releaseId 为 `dc3af64b3f5c3d01e675f0938a36a3854b9aabde`，`catalogSeoPageReadiness: true`。
- 已有 AI BFF `/api/ai/healthz` 返回 200；`/api/ai/readyz` 在 20 秒内没返回。存活检查通过不等于已能回答客户，本轮没有在生产创建聊天来验证。

证据：首页（原验证目录中的 `live-home.html`）、实际 JS（原验证目录中的 `AssistantWidget.PvdNAv7f.js`）、[API 版本](live-public-api-health.json)、[BFF 两种检查](live-bff.json)。这比“整个 BFF 都请求不通”的说法更准确。

### 不是不能 merge，先保护已发布的版本

当前 Agent 比 test 多 94 个提交，SEO 比 test 多 83 个提交。两者共同祖先是当前 main。`git merge-tree --write-tree` 只做合并试算，没有切换或修改分支；仅发现两个冲突文件：

| 文件 | 解决原则 |
| --- | --- |
| `apps/functions/public-api/src/index.ts` | 同时保留 SEO 的 catalog page reader/origin/catalogPages 接线和 Agent 的 salesCapture 接线 |
| `packages/db/package.json` | 合并两边新增的导出，保留 sales 和 catalog SEO 两类接口及各自依赖 |

这只是文本冲突判断，不是合并后的运行验收。Astro 配置、lockfile 等自动合并的文件也需要最终回归。

建议的发布顺序：

1. 先由各自分支修复并验证各自问题。Agent 先修 F1、F2、F3、F4，补齐当前提交检查；真实模型路径先恢复可用。
2. 由发布入口在 test 或专用发布分支整合双方已验收的提交，确保含线上实际已运行的 SEO 修复；**不把 SEO 功能分支合到 Agent 功能分支，也不反向合。**
3. 处理上表两处冲突，再跑产品、SEO、助手和函数产物相关回归。先写明每个服务将从哪个运行版本变到哪个版本。
4. AI CloudRun 和受控 intake 按各自程序交付；确认真实模型、公开知识来源和询盘授权可用，再开放前端新组件。具体先后必须满足新接口就绪后才开放入口。
5. 最后做有授权标识的真实询盘读回及 Hermes 成果读回，仍不发真实邮件。

普通 Deploy Test 会更新共享的函数和静态网站；只把 Agent 合入旧 test 后直接部署，不能保证保住当前线上 SEO。现在验证未通过，所以本轮没有替大家执行合并或发布，也没有去改 SEO 正在处理的状态。

合并试算证据：[完整输出](merge-dry-run.txt)。

### SEO 以前已经上线，为什么还在调部署

你的记忆有依据。SEO 交付记录说明：之前的公共页面、商品 SSG、Blog、后台发文和一轮网站交付已完成；10 月 29 日还通过受控入口更新了静态站点。

后续在做另一段工作：商品修改后自动更新静态 HTML、固定渲染程序归档、可靠唤醒和失败恢复。最新模块记录写明，一次真实交付已完成 35 批确认，随后在数据库 30 秒事务期限处停止，正在修复和恢复验收。因此不能把“已有基础部署可用”理解成“之后所有增量交付与恢复场景都已通过”。

以上细节来自本轮读取的 SEO 当前文档，未在本轮重做 SEO 的全部验收：`docs/delivery/README.zh-CN.md` 与 `docs/seo/continuation/README.zh-CN.md`（均读取 SEO 分支版本）。本轮实际确认的是线上 public-api 的运行 SHA，以及直接发布旧 test 的覆盖风险。

## 七、给 Claude 的简短交接

> 独立验证对象是 feat/sales-assistant@004e534c。Node 25 下：连接浏览器 58 项、组件交互 98 项、Astro 整站 4 项通过，后者 2 项按配置跳过。Node 22 的 AI 包 405 项通过，但整合后的 sales-contracts 对 jsonc-parser ESM 的导入使整站启动失败、官网 20 个测试文件失败。另有取消全部定制仍保留 logo、finish_reason=length 丢 usage 两个独立复现。真 VibeKB 工作区2/公开文档12已实际读通；现有模型两次约102秒超时，同主机极小请求30秒也超时，真实格式和usage未验收。8个缺陷注入经先验基线和空白库复核后均被抓到。手动补跑当前SHA后UI CI通过，聊天CI在DOM集合迭代的类型检查处失败，未到E2E；新分支push仍不自动触发旧助手CI，整站配置还未纳入CI。与SEO试合并仅public-api入口、db导出两处冲突；请在发布目标整合并保住线上dc3af64b等已接受版本，不交叉合并功能分支。没有改业务源码或生产。

## 验证记录与文字核对

实际读过：交接文档、ROUND2-DESIGN §15、ROADMAP 的发布与决定部分、VibeKbEngine 和知识库范围校验、need 合并规则、询盘 intake 与当前 fixture、三组 Playwright 配置与关键用例、相关 GitHub 工作流、CloudRun manifest、SEO 当前交付记录，聊天专用 TypeScript 配置，以及工程规范的部署、前端异步状态和验证章节。

措辞修正：将“BFF 不通”改为“存活接口 200、就绪接口超时”；将“整站真链路通过”改为“真实 Astro 页面与本地后端通过，模型和 Channel 存储仍使用测试替身”。核对了分支 SHA、Node 版本、测试汇总、模型请求耗时、线上 releaseId、两条手动 CI 的最终状态和浏览器实际采用的引擎。Node 22 打包产物和运行镜像的冷导入通过，源码执行错误的影响范围据此收窄。
