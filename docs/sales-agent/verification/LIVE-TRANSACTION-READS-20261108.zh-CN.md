# Sales 真实接线：事务重复读取修复（2026-11-08）

本次只减少同一次数据库事务内对同一文档的重复查询，不改客户权限、任务流程、发送权限或线上配置。分支从远端 `release/assistant-seo-20261104` 的 `dcffdff6072b73d233c5cd73e0a4e9ca41ad6bc2` 新建，未修改其他工作目录。

## 实际发现

真实 CloudBase 的一次只读来源检查用了 9,650 毫秒：10 次串行读取中，`channelSalesBindings` 查了 5 次、同一 `oemProjects` 查了 2 次。询盘与授权内容都通过检查，并非凭证已过期。同一事件在 Hermes 已写入一个任务和一个派发记录，但 Channel 的回执尚未成功保存，不能把重试状态理解成任务未创建。

这些测量说明事务离平台的 10 秒上限很近；尚不能仅凭这一次测量断言每一次失败的原因。延长 HTTP 等待时间也不能延长数据库事务期限。后续必须由真实接线验收确认授权事务和回执写回能完成；本记录不把离线通过写成已上线。

## SDK 契约核对

按 `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` 核对：

- 当前工具没有 Context7。使用 CloudBase 官方知识库 `searchKnowledgeBase` 搜索事务，再读取 `database/transaction` 全文；带前导斜杠的首次读取出现 TLS 错误，去掉前导斜杠后读取成功。
- 官方文档：[事务操作](https://docs.cloudbase.net/database/transaction)。第一次读取生成事务快照；提交前，事务的所有读取都在该快照上进行。事务不能超过 10 秒，超过后会被回收，后续操作返回 `DATABASE_TRANSACTION_FAIL`。
- `pnpm list @cloudbase/node-sdk wx-server-sdk -r --depth 3` 确认本项目安装 `@cloudbase/node-sdk@3.17.2`、`wx-server-sdk@4.0.2`。通过 Node SDK 实际解析到的数据库包为 `@cloudbase/database@1.4.3`。
- 安装包 `@cloudbase/database/src/index.ts` 从 `./transaction/index` 导入 `runTransaction`。该实现把文档查询绑定到同一个 `transactionId`；仅对 `DATABASE_TRANSACTION_CONFLICT` 重新调用整个回调，并返回回调的结果。不能误用包内较旧的 `src/transaction.ts` 作为运行契约。
- 新增离线探针运行这个真实安装包，以合成的提交冲突触发 SDK 自动重试，证明两个 Sales 适配器每次回调重新读取权限，而不是沿用上一次快照。

官方页面示例的返回包装与安装包实现不同，本实现保持已有适配器的返回约定，以实际安装包和可执行探针为准。不新增 SDK 方法或类型补丁。

## 最小实现

`createDeliveryStore` 和 `createCloudBaseSourceGrantStore` 在每个原生 `runTransaction` 回调内创建现有的 `createCatalogTransactionReads`，通过 DB 包新增导出路径复用。该 helper 早已用于产品模块，本次不改它的实现。

同一集合和 ID 只读取一次；调用者获得独立副本，修改其中一个返回值不会污染后续授权检查。并发重复请求仍串行排队，数据库失败后不会继续使用已缓存的结果。缓存有原有的文档数量和字节上限，超过时继续真实查询；不会为了提速跳过检查。

第一次写入前清空缓存，写入后的读取仍由原有门禁拒绝。不同事务、不同请求、SDK 冲突重试均创建新缓存，因此后续事务仍会看到当前的撤权状态。同一事务内再次远端查询原本也只会看到同一个快照；本次未引入跨请求权限缓存。

## 检查与边界

本机结果：51 项适配器/来源授权/交付回归、9 项既有 helper 回归、5 个授权缺陷注入全部通过；函数 typecheck、build、package:artifact、check:artifact 通过。

通用 `verify:cloudbase-sdk` 的 SDK 方法、事务返回、冲突重试等断言通过，但最后一个文章测试汇总检查未通过。原因已独立复现：本机 Node 25.6.1 默认输出 spec，而脚本只识别 TAP 的 `# fail 0` 等文本；同四个文章测试文件显式指定 TAP 后 26/26 通过。未扩大范围修改这个已有脚本，也不把整项命令记为成功。

- 新增回归先在旧实现运行：两种适配器各有两个用例失败，分别暴露返回对象污染和重复查询；修复后通过。
- 适配器回归覆盖：顺序/并发去重、集合边界、缺失文档、独立副本、新事务看到已撤权版本、写后禁止读取、失败后重试，以及真实 SDK 提交冲突的回调重入。
- 复用 helper 的现有测试还覆盖队列失败后拒绝缓存命中、并发串行、文档和字节预算、写入屏障。
- 保留并运行来源授权、询盘交付的业务回归，包括来源归属、撤权、超时重试、回执持久化失败和并发交付。
- 未从本工作目录发送请求、修改真实业务记录、发布官网或发送邮件。真实试运行由主任务单独执行，结果不能由本地测试推定。

本次文字核对涉及两个 store、原有事务 helper、SDK 的实际导入路径及事务文档。把“授权失败”改为“来源检查通过，但事务已接近 10 秒上限”，避免把网络/事务时限误说成权限配置错误。
