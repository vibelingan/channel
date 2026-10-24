# P7a1：真实云事务读取冲突

2026-10-20，原 pricing checkout，基线 a8926161。test 的三个服务和网站已部署。三件时钟通过现有 Sync to Products 更新到原商品，均未发布；分类、人工字段和图片 ID 保留，没有重复商品。T142 的 Edit 与包含完整来源规格的 Preview 可以打开，但明确点击 Prepare saved product 后返回未确认，catalogPreparationJobs 没有该商品任务。因此现场验收失败，20 件发布尚未开始。

## 证据和反证

用临时私有 Event 函数运行安装的 @cloudbase/node-sdk 3.17.2、生产 runCatalogPreparationJob 和实际云上 T142 数据。仅允许固定 owner 与固定商品；到第一次 set 前主动抛出 DIAGNOSTIC_STOP_BEFORE_WRITE，不写 DB、COS，不读取 JWT_SECRET、不生成登录令牌。真实 get 返回 data 对象，形状符合现有适配器。

原读取在 readCatalogPreparationInputs 中通过 Promise.all 同时读取 source、observation、link。首轮实际云运行在其中一条读操作返回 DATABASE_TRANSACTION_FAIL，消息为 ResourceUnavailable.TransactionBusy。同一函数交替运行三次原并发、三次仅改变读取顺序的对照：并发 2/3 失败，依次读取 3/3 到写入前检查点。随后改为引用生产 serializeCloudBaseTransactionReads helper，连续十次均到写入前检查点，零读错误，每次六次读，函数耗时 412–636 ms。这是这条实际路径的观察，不能据此承诺所有数据库负载都不会失败。

已重新读取 SDK 合约门槛、Engineering Craft 的 Counters & Data Integrity、Third-Party SDK & Wire Contracts 和 Test & Probe Efficacy。当前无 Context7 工具；核对 CloudBase 官方事务文档 https://docs.cloudbase.net/en/database/transaction 与已安装 SDK，保留同一事务、单文档 API、原回执校验和预算。官方文档没有作为本项并发限制的充分证明，根因由实际云端对照复现。

## 最小修复

四处原生事务 store 的 get 使用各自的读取队列：通用 catalogRowStore、商品保存 operationTx、分阶段审批和旧审批提交。队列在每次 runTransaction 回调中建立，SDK 重试会获得新队列；上一条失败后不再启动后续排队读，原错误继续抛给原事务回滚处理。没有新增重试、SDK 方法、类型替身或数据库写入，也不改变字段、分类、来源摘要、发布协议和图片引用计算。

只限制同一事务内部读取；不同商品的事务、批量操作的四并发及事务外独立图片/来源读取保持并行。原引用 proof 引擎仍可发起四个读取，CloudBase store 将同一事务内的实际 SDK 请求依次执行。80 proof 的最坏读取耗时需要在后续原生性能验收中测量，不能沿用内存 adapter 的并行时延。

## 本地回归与下一步

先给真实 CloudBase adapter 测试的事务 get 加入异步 I/O 和单个请求约束，原代码的 source=true 准备启动测试确定报 TransactionBusy，0/1 通过。修复后 DB 全套 2362/2362，零失败/跳过；新增读取完整性、失败后不再执行排队操作、独立事务仍并行和重试队列隔离测试。Node20 直接运行 DB 全套同为 2362/2362。根目录全量 7703 项中 7700 通过、0 失败、3 跳过；最终准备 UI 组合 60/60、lint 1085 文件、全工作区类型、最终 site 类型和 SDK 门槛均通过。绕过 helper 的变异被测试检出并按原 SHA 恢复。最终构建、精确提交审查与 test 重测仍在进行。

私有证据：output/pricing-clock-repair-2026-10-13/p3e1/native-prepare-diagnostic/native-results.json，以及 transaction-reads-red.log、transaction-reads-db-r1.log、transaction-reads-types-r1.log、transaction-reads-sdk-r1.log。临时函数已删除，并确认列表只剩原三个函数。原在售 487 件的公开逐字段基线已保存，未将准备失败写成发布成功。fullDeliveryReady=false。

实际审查 cloudbase-adapter.ts、catalog-detail-staging.ts、catalog-detail-commit.ts、catalog-preparation-store.ts、catalog-image-reference-store.ts、生产 helper 和对应测试。文案把“云端不支持任何并发”收窄为“这条同事务并发读路径已在实际环境复现冲突”，把“十次修复成功”写为“十次只读到写入前检查点”；检查了真实返回、零写入停止点、操作数和用户商品状态。
