# 产品查询与交互增量交付

本轮是在现有 AI 系统上补业务功能。第一版的基本问答没有重写；原先只在样例里展示的产品卡片、比较和澄清，现在有了 React → HTTP adapter → BFF → PostgreSQL → worker → 公开产品 HTTP API 的完整接线。

## 实际新增了什么

| 能力 | 原来的状态 | 这次的变化 |
| --- | --- | --- |
| 提问、回答、继续提问 | 第一版已有 | 复用；不计作新业务功能 |
| 精确停止、断线核对、防重复 | 上轮已补可靠性 | 复用同一运行身份和条件提交；查询也不能在停止后补入结果 |
| 产品卡片 | 组件预览可显示样例 | 服务器读取公开目录，投影名称、简介、图片、产品链接、查询时间和内容指纹；实际组件显示结果 |
| 产品图片 | 原来用固定占位图 | 显示公开 API 图片；图片下架或加载失败回到占位图，产品操作继续可用 |
| 两款比较 | 预览里用样例 | 选择本次查询结果比较名称和公开简介；不编造价格、库存、参数或交期 |
| 核对当前详情 | 未接 | 直接发结构化 lookup，不必再调用模型；重新查询公开 API，旧卡片注明历史资料，撤下的产品移出当前比较 |
| 澄清、查无结果 | 样例状态 | 严格解码模型计划后提问／查询；无匹配给出可继续输入的说明 |
| 查询／模型失败 | 有状态提示 | 对话内留下可见答复；后台已失败就用新任务重试，网络结果未知仍核对原任务 |
| 正式询盘保存 | 有前端预览，未接正式保存 | 联调页面继续隐藏提交按钮，避免显示一个实际上不能保存的入口 |
| 历史恢复 | 前端保留设计样例 | 用户已决定暂不实施；真实接线没有恢复按钮或浏览器持久凭据 |

当前关闭再打开同一页面的助手，内存中的对话保留；刷新页面则新建会话，没有自动恢复。

历史恢复若以后做：记录存在服务器，浏览器只保留会话凭据。清除站点存储、换浏览器／设备、无痕窗口关闭或凭据过期后，都不能据此找回。不能承诺匿名访客有跨设备的账号历史。

## 原模块编号与实现位置

沿用 MIU 4／5a（有界公开产品查询）及 MIU 11（组件与业务接线）。没有改成新的 A／B／C 编号。

- `apps/ai-worker/src/product-workflow.ts`：固定 origin 的公开 HTTP 读取、严格计划解码、字段投影与内容指纹。
- `packages/ai-contracts/src/products.ts`、`chat-v2.ts`：卡片、显式查询动作、最终事件的有界格式。
- `apps/ai-bff/src/server.ts`：消息入口校验，v2 显式投影结果；v1 继续只返回原字段。
- `packages/ai-store/src/store.ts` 和 migration 004：查询动作跟原消息一起保存；同 key 换正文或动作拒绝。
- `apps/ai-worker/src/worker.ts`：复用排队、取消、任务 fence 和最终事务；计划只能选搜索、限定 ID 查询、澄清或知识回答。
- `packages/ai-engine/src/port.ts`、`packages/ai-engine-anythingllm/src/engine.ts`：新增服务器拥有的 `channel-products-v1` 命名 profile，沿用原供应商连接。普通 profile 不附加产品规划提示；原来的供应商零工具检查继续有效。
- `apps/site/src/islands/ai/assistant/`：复用 Experience、Messages、状态与 hook；新增 `ProductThumbnail`，连接产品事件、比较、更新标识和失败重试。

每轮最多一个公开查询动作；搜索最多 6 项，按 ID 核对最多 2 项，每次读取 5 秒上限、响应 256 KiB 上限。服务器设置目标 origin，浏览器／模型不能传任意 URL；无管理员／VIP Authorization，无 DB／OSS 工具权限。结构化结果与最终文本一起做带任务版本的条件提交。知识回答仍须通过原有来源检查，不能因为走产品 profile 而发布无依据的承诺。

## 本地验证

- PostgreSQL：store 40、BFF 12、worker 34 项通过，无跳过。包含动作持久化、同 key 换动作拒绝、受控读取、最终结果事务、v1/v2 字段隔离、取消与晚到结果。
- 现有 AnythingLLM adapter：102 项通过，新增命名 profile 的真实 HTTP 请求构造测试。
- 前端状态／传输／公共链接：20 项通过。后台已失败时可见答复和新任务重试有直接断言。
- 新接线浏览器：18 项，桌面及 Chromium 手机尺寸。真实 React／HTTP／PG／worker；模型与目录内容使用明确标识的本地测试数据。覆盖查询、图片、图片失败、比较、刷新更新／下架、澄清、无匹配、失败、停止、丢失回执及密钥页本机下载。
- 既有 29 状态和交互浏览器回归：90 项通过。这包括设计预览，不能据此宣称历史恢复或正式询盘已接好。
- 缺陷注入：6 处全部被测试抓到，包括新增的最新问题保留、公共字段投影、动作重放身份，以及原取消版本、事件身份、流的任务范围。变异只作用于临时副本，工作树源码未被测试篡改。
- 类型检查、Astro 检查、公共站点构建、AI 服务构建通过；Astro 为 0 errors、0 warnings、11 hints。公开构建验证了 19 份 HTML、10 个可索引 canonical URL、sitemap 和验证文件；开发预览不进入公开构建。

证据：本地 `output/assistant-chat/`、`output/assistant-ui/`；缺陷注入由 `scripts/verify-chat-slice-guards.mjs` 重跑。CI 自动执行同类检查。代码提交为 `8a9129fbe6b908d346e3116303394688ddd5d491`；[完整后端与浏览器接线 CI](https://github.com/vibelingan/channel/actions/runs/40995969239) 已通过。[前端回归与构建 CI](https://github.com/vibelingan/channel/actions/runs/40995969342) 也已通过，二者检查的都是上述代码 SHA。定向变异的来源指纹和结果见 [PRODUCT-GUARDS.json](PRODUCT-GUARDS.json)。

## 两轮复核及修正

第一轮核对现有能力与数据边界，阅读了 worker、store、BFF、engine port／AnythingLLM adapter、contracts、现有 Messages／Experience／hook 和 `public-api/src/handler.ts` 的公开投影。修正按 ID 读取返回其他 ID 时拒绝；附加私有字段即便混入内部事件也不能穿过 BFF 投影；非法图片 URL 降级，不让整次产品查询失败。

第二轮核对真实组件和异常，检查了 HTTP adapter／reducer、取消监视器、查询限时、前端比较中的历史版本和下架状态、数据库 migration 004、CI 与加密交接脚本。修正失败后错误重试原终态的问题、图片缺失的空框、测试文件并发清空同一 PG 库的死锁、超过 30 条消息后仍取最早上下文导致遗漏当前问题；BFF 默认测试改为顺序执行。查看了桌面／手机截图，并执行连续浏览器操作。

文字复核实际涉及本交付记录、`RESEND-OWNER-SETUP.zh-CN.md`、README、MIU 计划和后端顺序。把“完成提问→回答”改成“复用原问答，新增产品 API 接线与交互”，并把“连接真实后端”具体写成实际组件／BFF／数据库／worker 与测试模型／测试目录的区别。核对了现有公开 API 的 search、items、published、图片路由和明文密钥不进入输出的行为。

## Resend 交接交付

[老板操作说明](RESEND-OWNER-SETUP.zh-CN.md) 写明 Team、Inbox、API Key 菜单和权限、Webhook 菜单与事件，以及由谁完成哪一步。技术侧可用 API 注册 Webhook，前提是已有部署并验证的 HTTPS 接收地址；本轮没有创建实际 Webhook。

提供离线 HTML 加密交接页及配套 CLI，使用 RSA-OAEP／AES-GCM，私钥在 Git 外且权限 0600；页面不联网、不保留输入，只交加密 JSON。Node 测试 2 项验证往返、篡改拒绝及页面限制；浏览器 2 项（计入前述 18）验证本机下载、实际解密、清空输入及零 HTTP 请求。只使用合成密钥；客户真实 Key 尚未提供。

## 尚未完成与启用边界

真实模型在客户知识库上能否稳定输出这些计划，尚未在本轮环境实测；不能把确定性规划器当成真实 AI 效果。产品 API 路径与投影已按当前代码核对，但生产 origin 的配置、代理、真实目录和移动端设备须独立验收。没有部署、真实发信或修改客户账号。

服务器配置 `AI_PUBLIC_CATALOG_ORIGIN=https://已核对的公开站点域名` 才启用新产品工作流；只允许 origin，无私有路径／用户名／密码。浏览器仍需 `PUBLIC_AI_CHAT_V2=1`。关掉新功能时回到原 profile 与旧 Widget；保留新增的 nullable 数据列，不用降库删除已经保存的动作。

下一段仍按原 MIU：真实模型的规划效果验收；MIU 8a／6d 的客户核对、联系方式、同意和正式询盘唯一保存入口，随后才是事件触发 Sales。Resend 密钥不会阻挡官网这些代码的继续开发，邮件实际接入和真实发信另做验收。

最后复跑时系统盘发生 ENOSPC，已将本轮测试临时目录改到 Lexar 后完成复跑，未清理其他工作树或项目文件。

## 负责人操作说明修订

按用户反馈，将 `RESEND-OWNER-SETUP.zh-CN.md` 收敛为一条顺序：客户创建专用 Key → 在本机加密 → 交加密文件给 Sean。删除 Invite 与密钥交接并列的写法；不再让负责人处理 Webhook 事件和技术命令。此前本节所述的长版操作内容已被该短版取代。

核对了官网实际 HTML 的 mailto 链接、`apps/site/src/i18n/content/en-US.md`、`apps/site/src/layouts/BaseLayout.astro`，三者均为 `sales@supplychainsai.com`；这只能确认公开联系地址，不能证明 Resend 已授权该发件身份。另核对 Resend 官方密钥管理与权限文档。具体措辞从“选一种安全交接方式”改为“请创建一把接入专用 API Key，加密后交给 Sean”，并明确技术人员邀请邮箱与测试收件邮箱不是同一用途。仅修改文档，没有修改邮箱配置或发信。
