# P3e7c1 冻结管理员提交与服务器补全

基线 `5594e9e013791dd945ddf4df90c61131cc887f5e`。本步完成服务器补全的冻结与重试约束，实际 Admin 开始/保存入口接线在 P3e7c2 继续。原 UI P1、真实云事务、性能及三件时钟/20 件商品验收仍未完成，`fullDeliveryReady=false`。

## 问题与实现

原 `prepareProductOperationSave` 要求保存内容与开始时冻结的 `operation.values` 精确相等。既有 `fn-admin.withAdminEditsKept` 会为 Changed/Removed 商品的管理员描述、图片编辑补上 `supplierDecisions.keep`，绑定当时的 `incomingDigest`。如果等保存时才补全，正常编辑会与已冻结的提交不符。

现在公开开始请求先验证并复制用户 patch，检查网站名称/描述合约，再计算原提交摘要。可信服务器 normalizer 调用实际 helper；只有 `supplierDecisions` 可以补全，其他网站字段必须与原提交相同。内核冻结补全后的完整 patch，后续保存仍精确比较，未放宽保存、操作者、来源或分类约束。

所有新公开 start 都记录一个 64 字符 `submittedInputDigest`，包括没有 normalizer 的调用。这使同一原提交在补全后仍能通过普通 facade 重试；没有 normalizer 时仍只有一次原 persist，没有新增数据库查询。内部旧 start 不带摘要，读回和严格重放仍有效。新摘要进入根的 `requestDigest`，篡改和显式 undefined 都拒绝。公开 JSON schema 显式排除该内部字段；normalizer 只能作为服务器函数参数传入。

带 normalizer 时先通过原持久化入口查询同一根，核对 actor/product/operation、原摘要、intent 和 expectedUpdatedAt。匹配就返回首次冻结的状态，不重读新来源、不重算决定。并发的同一原提交保留先提交的补全结果；不同原提交返回 CONFLICT。来源、保存状态改变及提交成功但回应丢失后，都按同一根重放。未知读取错误继续抛出，撤权不留下部分根。

## 容量与成本

公开请求仍为完整 256 KiB；内部仅对带提交摘要的开始/读回和绑定保存提供额外 1024 字节元数据余量。用独立 Python JSON UTF8 计算，三项合法决定加摘要的最坏新增量为 475 字节。实际测试构造完整 256 KiB 合法请求，补全三项后可冻结、捕获绑定保存；原请求再多 1 字节就在回调前拒绝。根只保存补全后的 patch 和摘要，没有第二份 raw/original/submitted values。原 512 KiB 保留根、1 MiB 审批根预算继续执行。容量测试不代表新照片已可发布。

没有新增 SDK 方法、类型 shim、依赖、环境变量、锁或数据库。CloudBase 原事务/严格 ACK 语义不变；Context7 不可用，沿用本轮已核对的官方事务契约和安装包 source/types。实际 provider 首读快照/写冲突、COS 与 P95 仍是后续发布门槛。

## 测试与 review

新增 27 项：DB 5 项、实际 Admin+JSON 22 项。495 相关测试通过；全量 5751 项和实际 Node20 相关 2763 项通过，均无 fail/skip/cancel。19 个 workspace 类型检查、E2E 类型、standing SDK、六文件显式 Biome 与 diff check 通过。早期 callback 未调用、补全后 strict save 拒绝、服务器改用户字段三项业务反例先红后修；后续 30001 字符描述反例暴露网站校验较晚，已移到 normalizer 前并保留具体字段错误。类型检查修正三处同一可空 map 索引使用；未用类型断言或 unsafe formatter 绕过。

9 组最终源码故障注入全部检测到，其中 8 组产生 15 次重叠测试失败，1 组实际 index 脱线在 486 项此前 SDK 控制通过后失败；三个源码 SHA 全部恢复。覆盖服务器篡改网站字段、回调原地修改原提交、公开摘要注入、遗漏网站预校验、并发重放、旧根兼容、摘要未绑定和元数据挤占用户容量。注入后重建探针并重跑通过。

498 项安装 SDK 探针保留原 474 项，新增 raw workflow 与真实 DB index 各 12 项。使用实际 `withAdminEditsKept`，覆盖精确 draft 保存、来源变化后不重算、旧根只读、三个坏 ACK 回滚、提交成功/回应丢失、等待期间嵌套输入变化，以及来源 coded/malformed 读取错误零写入。仅 HTTP 被替换，不构成真实云并发证据。DB 另覆盖新摘要走完真实 owned 配置页、媒体、引用暂存、最终发布及撤回后的历史回执。

人工 review/simplify 覆盖三生产文件、三测试文件和本次四份记录，交叉核对实际 helper、旧 handler、身份保存、源输入与原生适配器。保留统一精确保存规则，不再增加另一套保存分支。humanizer 实际核对这些文件与既有 P3e7b 记录：把“没有 normalizer 的原请求完全不变”改为“新公开 start 也保存摘要，但仍只有一次 persist”，并把旧记录中的三次诊断澄清为两项唯一类型收窄错误。数量来自执行日志；上述措辞核对是人工 review。

本步精确提交的三函数/site 编译、真实 PNG 跨进程与原流程组合补充在提交 review 后执行。原 UI 整体发布丢回应 P1 保留；新 normalizer 尚未由客户入口调用。下一 MIU 接 Admin 开始/保存的实际 helper 和原生绑定保存，之后继续新照片、live 私有候选、审阅回执、完整 continue/UI 与组合验收。
