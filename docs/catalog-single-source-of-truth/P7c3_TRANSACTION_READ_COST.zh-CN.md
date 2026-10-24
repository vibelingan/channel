# P7c3：只消除同一 catalog 事务内的重复读取

状态：本地实现与小流程通过，尚未部署，线上耗时门槛未通过。

实际反例使用原 native 持久化桥接、9 张图及 3 个共同待结算凭证。原逻辑读取 58 次，其中 3 个凭证被读取 27 次；优化后 34 次、每个凭证各 1 次。商品仍未发布，9 张图的有效引用基数均为 3。不能把读取减少 41% 写成实际发布耗时减少 41%，也不能据此宣称 8 秒/60 秒门槛已经通过。

仅 catalogRowStore 与 persistStagedApprovalInCloud 使用事务局部读复用。实例在 SDK runTransaction 回调内部创建，每次重试、每个请求都重新开始。原通用 CRUD/鉴权事务仍使用原串行队列。缓存命中也排在原队列里，任一原生读失败后，后续命中和新读均得到原失败。集合和 ID 分别编码；首次结果返回前捕获独立副本，命中返回独立副本，不让调用者修改影响后续校验。

任何 set、patch、remove 尝试都在等待租约保护或发出 SDK 写入前同步清空并永久禁用复用；即使写入失败也不恢复。原写回执、回滚、CAS、租约、来源代数、只读后写计划和逻辑操作预算不变。最多保留 98 个文档、单文档 512KiB、合计 4MiB JSON 字节；超限、日期、特殊 SDK 对象或无法克隆值使用原实际读取，不截断或转换值。没有跨事务缓存、TTL 信任、新持久字段或新的 SDK 方法。

SDK 证据：Context7 当前不可用；此前 CloudBase MCP 官方事务文档说明同一读快照、100 操作/30 秒，补充 web 获取该官方 URL 超时，不以失败获取当作新证据。独立读取实际安装的 @cloudbase/database 1.4.3 dist/commonjs/transaction/index.js：每次回调新建 Transaction，只有 DATABASE_TRANSACTION_CONFLICT 原错误重试，其余回滚抛出，返回 callbackRes。未误读旧 transaction.js。pnpm verify:cloudbase-sdk 通过，未改类型 shim 或方法签名。

小流程 364/364 通过。数据层第一轮发现旧删除回归仍固定要求 4 次操作；实际现为图片读、已提交移除凭证读、确认图片写共 3 次。只更新该精确次数，保留状态、零计数、epoch 加一、清空账本及拒绝未确认写的全部断言。随后数据层 2369/2369、0 跳过，类型复查通过；中间红测、类型错误及第一次全数据层失败日志均保留。

审查实际阅读 cloudbase-transaction-reads.ts/.test.ts、catalog-detail-staging.ts、cloudbase-adapter.ts、catalog-operation-approval.test.ts、cloudbase-adapter.test.ts，核对失败队列、调用者别名、在途读与写入竞态、事务重试和 SDK 特殊值、内存上限及引用计数结果。文字将“缓存让发布更快”修正为上面可核对的原生读次数及尚未通过的实际耗时门槛。

下一检查点：与原浏览器、准备 worker、编辑/单件/批量审批组合回归；完整类型、构建与最终全仓检查后再发布 test。实际 100 正常操作与 20 轮批量、冷图和坏图、真实 20 件及恢复仍按原验收门槛，不以本地读次数代替。
