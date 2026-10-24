# P3e7d8 普通入口复用原发布协议

状态：创建后的发布本地单元已实现、review并验证，未部署。继续接表格单件/批量；live-edit 与有编辑内容的保存仍按 P4 处理。

## 问题与保留规则

创建草稿已由 P3e7d7 保证原回执，但 `createRecord(...published:true)` 后半段仍调用旧 update/approve/publish。表格发布同样走旧链。丢失最终回复不能仅凭某件商品后来变成 published 判定自己的发布成功，也不能报“未发布”而真实结果未知。

复用 createPublicationBatch 的账号、端点、原 operationId、共享四并发、准备/批准/引用阶段和匿名公开 revision 读回。分类、价格、图片及权限合约不改；无分类商品不强制归类。创建先保存商品，再以空 patch 发布；表格也以空 patch 发布。用户编辑内容的 native 保存与 live 刷新不借空 patch 冒充。

## 最早断点的恢复

现有 journal 只保存 scope/digest/cursor，若 start 根本没有到服务端，则 GET 一直 NOT_FOUND。空 patch 不含私有正文，可以额外保存 `originalStart:{expectedUpdatedAt}`，保留原 productId/operationId。只对实际空 values 的 start 捕获此字段，不保存 token 或商品内容。

普通丢回复仍只查原任务，不自动重发。用户显式 Continue 时，先 GET 原 scope；仅当服务端明确 NOT_FOUND、尚无已绑定 inputDigest 且有原空 patch 版本时，才用相同 operationId、相同 expectedUpdatedAt、values={}重发原 start。服务端已有同 ID root 时重放只 inspect，输入不同则拒绝；不能重新生成 nonce、换到新版本或覆盖原 root。已有 digest 的 root 丢失按异常处理，不借 metadata 重建。

用户显式 Stop 遇到同一最早断点，可先用相同原 start 仅建立 reservation，再取消原 scope，绝不执行 continue 或批准。Check 保持只读。原版本已变化时拒绝，保留记录及明确原因，不伪称取消成功。普通新发布不增加请求或共享锁；额外 pointer 仅几十字节，不增加集合或 SDK 调用。

## 普通入口与恢复结果

创建后的发布只在创建版本仍未发布、未归档且未变化时开始。成功需要原回执与匿名公开版本双确认。失败或未知返回“商品已保存、发布需处理/未确认”，附原 checkpoint，不使用含“未发布”断言的 DraftSavedError 描述未知结果。表单禁止重复创建，提供原任务 Check/Continue/Stop；刷新后的恢复仍指向同一商品。

表格结果把原 confirmed、needs-action、unknown、not-started、cancelled、historical 逐件映射；重试必须使用原 checkpoint/attempt。已发布且无需写入的条目单独显示 unchanged，不冒充本次发布回执。非商品 CRUD、Disable/Archive 既有行为保留，后续各自接线。

## 风险与验证

先红测原 start 未到服务端后的重开恢复与 Stop：必须只产生一个 root，原 ID/版本不变；Stop 不产生批准、公开或图片引用。补 journal 原版本不可改、无正文、创建 namespace 拒绝发布 metadata、有 digest 不重建、非空 patch 不凭空变成空 patch。再测创建→发布→公开读回→按原回执撤回、丢完成回复、公开读回失败、角色变化、表单恢复和表格20件。每个可跑流程先组合测试再继续；最后执行完整矩阵，实际 test 与三件 resync 仍为后续门槛。

## 已落地的创建后发布单元（2026-10-19）

创建后的发布已改用原生 owned batch，不再调用旧 update/approve/publish。正常创建、完成响应丢失、公开读回失败、私有商品读回携带不同回执、首次 start 未到达、审批关闭、生成 nonce 失败均有实际处理器测试。未确认不再显示“未发布”；草稿保留，原任务保留，界面提供 Check / Continue / Stop。创建指针在检查后继续保留，打开已有商品前再读当前值并确认没有未决的本账号发布任务，随后才清除指针。

浏览器实测发现缺描述的发布原先到了最终事务才拒绝。现在创建前复用现有 publication 校验，缺项时保持表单可编辑且不创建商品；用户可补内容或取消 Published 保存草稿。仅有描述图片、询价商品、直接创建 Archived 仍可用，没有提高现有发布要求。

若 start 从未到达、商品又被修改，Stop 的原版本 reservation 会明确冲突。此时只有在读到新的单调 updatedAt、再次只读确认同一 root 为 NOT_FOUND 后，才移除本地指针并允许查看当前商品；不宣称服务端任务已取消，不改变商品，也不以网络错误当不存在。原 expectedUpdatedAt 已不能通过服务端保存守卫。最终 root 读取失败的反例会保持未决，不能打开编辑。已有 root 则继续使用服务端取消，已完成的发布不会被 Stop 自动下架。

### 验证与界限

证据目录：`output/pricing-clock-repair-2026-10-13/p3e1`。

- `created-native-site-full-r1.log`：site 1220 项中 1219 passed、0 failed、1 项图库浏览器环境门控；`created-native-gallery-gate.log` 显式启用该项，1/1 passed，无 skip。
- `created-native-node20-final.log`：最终相关 Node20 测试 271/271。site 全轮包含 Chromium/WebKit 创建表单各10子流程及2个父项，22/22；没有凭 API 成功替代浏览器流程。
- `classification-formal-created-native-r2.log`：实际 Astro 15页构建后，11/11 后台流程通过，无 retry/skip；包括创建恢复、发布恢复、20件保留分类发布、原回执撤回。runner 已确认删除本轮 DB、服务和临时构建。
- 新的构建恢复用例通过真实 HTTP 创建/发布，使用已有合法 PNG，给构建页面恢复真实原任务指针；它不验收 CloudBase 上传。首轮上传被 local-disk 明确拒绝，失败日志保留。没有增加生产上传替代通路，也没有将其算作上传通过。完整 New Product 表单创建后发布在 Vite 的两个真实浏览器中执行；真实 test/COS 上传仍待现场验收。
- `created-native-fault-proof.json`：换原ID、忽略私有回执、猜测不存在、提前清除创建指针四项故障均检出，源码按 SHA 恢复。首轮故障选择器未选中用例，已保留原日志并用明确的用例名重跑，未算检出。
- Astro 230文件 0 errors / 0 warnings / 8 hints；site/E2E 类型通过，19文件 Biome 和 diff whitespace 通过。已实看390px恢复成功、原请求过时两个截图，文字/按钮无横向溢出。

Review 对照原生 start/save/get/取消的输入绑定、单调时间、共享四并发、journal 持久化、现有创建/分类/编辑调用者、图片引用和公共读回。发现并修复：创建记录过早清除、生成发布 attempt 失败丢失“已保存”上下文、审批关闭时出现不存在的任务入口、缺描述末端拒绝、停止过时未到达请求无退出、打开已有商品沿用陈旧快照。旧创建发布的两条固定链路 mock 测试由13条真实处理器场景替代；普通编辑及非商品 CRUD 测试保留。

实际审阅本次19个代码/测试文件及 `catalog-product-state.ts`、`catalog-product-operation.ts`、handler、validateProductPublication、CollectionView、RecordForm。措辞从“创建成功/未发布”改为“商品已保存、发布未确认”，核对实际 published、operationId、revision 与恢复前后商品内容。当前只完成创建发布本地单元；表格单件/批量、live-edit 等剩余入口、P5历史修复、精确制品与真实3件/20件验收仍开放。未部署、未推送、未修改真实商品，`fullDeliveryReady=false`。
