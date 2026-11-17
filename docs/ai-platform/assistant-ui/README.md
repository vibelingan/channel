# 官网助手前端与后端交接

## 2026-11-17：失效会话反复报连接错误

在用户原官网产品标签页，连续两次发送 `what product do you have? Top wirless headphones` 均由真实 BFF 返回 401；新官网会话能正常回答无线耳机产品。不是依据不足的拒答，也不是服务整体停机。旧版组件只在页面首次加载时检查凭据有效期；标签页一直打开后，提交仍复用失效凭据，401 又被当作普通网络失败，后续问题继续使用同一失效身份。

现在每次发送前检查有效期。收到明确的消息提交 401 时，只建立一次新访客会话，并把尚未受理的当前问题提交一次；新会话的事件读取编号同时归零，保留页面里已有的对话。第二次仍返回 401 就停止恢复并清除无效缓存，输入框继续可用。429、503、网络结果不明以及消息已受理后的事件连接失败，都不自动重发问题，避免重复模型调用。没有延长凭据期限、读取旧会话的权限或变更后端鉴权。

验证：原代码在新增的三类回归中失败（401恢复、页面打开期间过期、恢复次数上限）；修复后桌面/手机模拟的13种场景共26项通过，包含新会话事件编号归零和已受理消息不重发。站点单元测试1599项通过、1项条件跳过，站点与浏览器测试类型检查、Biome检查通过。真实官网原标签页的401与新会话成功用于定位，模拟IO回归不代替发布后验收。

代码提交为 `b9b5aba01c9ee334d21edf62586a6e0d39c16c84`，推送到既有 `release/assistant-seo-20261104`，源代码的 [Assistant UI foundation](https://github.com/vibelingan/channel/actions/runs/44069073020) 与 [Sales contracts](https://github.com/vibelingan/channel/actions/runs/44069073106) 检查均成功。随后将实际服务官网的 `test` 从 `10f04fc3` 正常快进至同一提交，通过 [Deploy Test 44070482872](https://github.com/vibelingan/channel/actions/runs/44070482872) 尝试发布；没有另开分支或PR。

该次发布的22项前置检查通过，但11:54 UTC在第45批托管上传时超时，原任务已停止。该批12个商品页面实际为8个新版本、4个原版本，其他内容均与已登记字节一致；官网聊天页面仍加载旧组件 `AssistantWidget.Czz3_t8-.js`，因此此时不能宣布热修复已上线。没有回退产品、询盘或文章数据，也没有重发模型问题。

恢复设计与实施范围：沿用现有原任务、原发布包、共享发布锁和逐页读回，不直接清锁或盲目重跑。旧恢复入口只认旧手工发布任务，且要求整批全部写完，补齐对现有 `Deploy Test/test` 来源及部分写入的识别。每个页面必须仍为登记过的原版或新版，普通读取、强制核对缓存、条件读取三种方式必须一致；任何第三种内容、未停止任务、未过期锁、未清理临时函数或来源不符均停止。读回只结束原任务的未确认状态，保留失败和未完成发布记录，网站与业务数据写入均为零。随后才由既有受控发布流程根据当前公开资料完成发布。测试分支手工恢复的执行代码还必须通过同一提交的完整离线CI，不能因上次正常部署失败而跳过源码和浏览器检查。发布、恢复及官网自动恢复验收结果继续补在本节。

恢复补丁本地验证：新增的正常发布中断、部分写入在原实现均失败；补丁后44项恢复与来源检查通过，完整发布脚本回归1961项通过、无跳过，Biome及差异检查通过。为避免未确认写入期间自动启动第二次正常部署，这个恢复提交用 `[skip ci]` 禁止推送触发的任务；随后在 `test` 手动执行同一提交的完整 `SEO release modules (offline)` 检查，成功前不执行云端恢复。这不是免除发布检查，手动检查和恢复运行号继续记录在此。

恢复执行补记：`358726dc` 的完整手工CI [44081016246](https://github.com/vibelingan/channel/actions/runs/44081016246) 成功；[44082158063](https://github.com/vibelingan/channel/actions/runs/44082158063) 在读取原区域函数回执前安全停止，未结束旧任务。原因是正常 Deploy Test 的证据包同时保存两个 output 子目录，原回执实际位于 `site-delivery/regional/result.json`，旧手工发布包才是 `regional/result.json`。已从原任务真实下载包核对回执的run、SHA、清理状态及零业务写入，再按已核验的发布来源选择这两个固定目录，不扫描任意文件。对应回归先复现ENOENT，再通过；相关证据、恢复和来源回归76项通过。新的执行提交仍须完整CI通过后再试恢复。

后续真实进展：`fbb1d847` 完整CI [44083495267](https://github.com/vibelingan/channel/actions/runs/44083495267) 成功，[44084739926](https://github.com/vibelingan/channel/actions/runs/44084739926) 完成12页原/新版核对与原任务状态登记，网站和业务写入为零。官网已写入新版的真实商品页加载 `AssistantWidget.DTFzLaKg.js`，使用合成无效访客身份测试得到真实401→201→202→events200，事件编号从0开始；同一句 `what product do you have? Top wirless headphones` 返回无线耳机介绍，消息只受理一次，输入框可继续使用。这项功能验收已完成，不与原通用商品页面尚未更新混说。截图和不含凭据的HTTP记录在本机 `output/assistant-ui/live-401-recovery-20261117.*`。

发布收尾仍在进行：[44085351545](https://github.com/vibelingan/channel/actions/runs/44085351545) 误选只处理商品变动的refresh模式，没有待处理商品变化而正常退出，不能算已发布程序；改用完整fresh模式的 [44086221594](https://github.com/vibelingan/channel/actions/runs/44086221594) 在新网站写入前停止。后者暴露了另一处测试遗漏：调用端支持部分HTML写入，但实际区域函数仍把核对结果固定为整批新版。补丁把逐页已核对的path/bytes/sha256送到运行端，由运行端验证每页只属于原版或新版、顺序和数量不变，并与原已存整体摘要及任务证明一致；不修改旧证明、不放行任意摘要。增加通过实际安装SDK、真实区域handler与数据库事务层的离线联测：混合版本可恢复，缺少、改写、调序或其他页面的证据全部拒绝，业务记录不变。这种跨调用端/运行端的行为不能只用成功替身验证。运行端类型检查与33项单元测试、32项调用联测通过；完整发布脚本1964项通过。新的执行版本仍先过完整远端CI再恢复现场。

发布恢复补记：运行端修复 `16f93218` 的完整CI [44088907914](https://github.com/vibelingan/channel/actions/runs/44088907914) 成功。随后 [44090023993](https://github.com/vibelingan/channel/actions/runs/44090023993) 已通过真实运行端的混合页面恢复，但在新网站写入前停止：旧恢复分支误把未改动的分块视频当成外部修改。实际下载 `media/oem/factory-video-display-015f0629.mp4` 得到200、10,561,994字节，SHA256为 `015f062970ce54f90f5bddc83585c8f0946a1e10378125110a0c6e62b71b14d0`，与前后归档一致；该文件的分块ETag不能当整文件MD5。恢复流程现在复用正常发布已有的内容核对，仅对所有归档中均未变化的此类文件读回；路径、字节数、SHA256、当前ETag和修改时间必须全部吻合。新增真实本地HTTP交付回归：未改动视频不重传、当前内容发布成功；同大小但已改动的视频仍被拒绝、没有新网站写入，原未完成状态保留。没有关闭外部修改保护。相关24项回归与完整1967项发布脚本测试通过，Biome和差异检查通过。

最新发布检查：恢复提交 `5d250308960e8b00ff14cdfd4bb375e3a9bc7db0` 已推送原release与test；同一SHA的完整远端CI [44098725023](https://github.com/vibelingan/channel/actions/runs/44098725023) 全部成功。随后启动 [44100498550](https://github.com/vibelingan/channel/actions/runs/44100498550)：使用既有“指定已批准程序＋当前资料”路径（`action=restore`、`product_source=refresh`、renderer=`b9b5aba0`）。这里restore指选定程序，代码明确禁止在商品变动记录启用时恢复历史内容快照；没有待处理商品变化也仍会发布指定程序。当前目录状态与商品撤下记录须重新核对，不能只凭旧商品快照发布。网站验收登记于2026-11-17 14:50:51.704 UTC完成：`site-44100498550-1` 为SUCCEEDED，activation=`1c9aa18b-46a3-41b3-89ea-a6f9b65d1723`，artifact=`14334909593`，清单SHA256=`a8aedf83b650874ba4d60dfe16f855c658a2cc2b29aa685773fb95a435b2f25d`。执行代码为5d250308，网站程序为已批准的b9b5aba0；不是用恢复程序的版本号冒充聊天组件版本。原通用商品入口 `https://supplychainsai.com/products/item/?id=50633c37-434c-4374-a540-f071a00fc799` 已实际打开，加载同一修复组件 `AssistantWidget.DTFzLaKg.js`，面板可打开、输入框可用、没有错误提示；已检查保存的浏览器截图。没有重复模型测试，以同一组件此前真实401自动恢复与原问题完整回答作为功能依据。最终发布任务全部成功，528个当前商品页面登记完成，自动生成程序的active记录已读回为b9b5aba0、本次验收run。发布锁、未完成网站状态和未确认操作均为空；两项临时区域函数回执均为cleaned=true、unconfirmed=false、businessWrites=0，未恢复产品、询盘或知识库数据。完整的发布读回及桌面/手机尺寸页面检查保存在该运行的site-delivery-evidence artifact；原通用商品页的聊天打开检查及截图位于本机 `output/assistant-ui/original-product-route-fixed-20261117.*`。

措辞修正：“简单产品问题被拒答”改为“消息提交被401拒绝，前端没有恢复失效会话”，区分知识回答、调用身份和网络状态。范围只含现有v1官网组件，不启用后置v2/流式功能，不改变Sales、Apollo或公开知识范围。

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
