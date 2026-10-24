# P4c9a：已发布编辑的图片引用差量

本单元仅补齐已批准方案中 refresh-live 的引用计划契约，不开放现有 native 草稿保存/审批中的 live 门槛，不改变编辑入口。当前 live 保存仍走旧链路，整体尚未完成。

代码观察：catalogReferencedImageIds 是网站引用集合的共同定义，包含当前行图库/描述图，以及旧批准版本的图库/描述图/配置图。现有 native 首次发布从空集合计算 +1，不能直接用于已经发布的商品，否则继续使用的图片会重复计数，旧批准版不再使用的图片也不会释放。0、105、10000 配置的三条行为红测均证明当前首次发布分支不能替代 refresh-live。

新的 live binding 使用独立 kind，保存更新前后图片集合的摘要和树承诺。实际引用页和最终业务写入必须在同一事务快照取得当前已发布商品，重算 before/after 和树，再与原承诺核对。继续使用的图片 delta=0；删除图片 -1、新图片 +1。没有把旧配置图片数组再复制到 Root。10000 配置反例包含约 20000 个变化，binding 仍小于 1024 bytes。

历史回执读取与写入计划分开：readOwnedApprovalReferenceCommitment 只能生成待查的 proof 身份，不能生成图片变化列表，也不授予写入权。live 的 readOwnedApprovalReferencePlan 缺当前商品则拒绝；下架、归档、换商品、新旧引用变化都拒绝。未来终态读取还必须核对已原子落库的 proof；本单元没有把宽松的元数据读取替换进现有事务。旧 v1 草稿承诺形状、摘要和从空集合发布的语义保持；明确 refresh-live 不能借用 v1。

接线前仍须完成：保存候选行时的原子引用维护、原任务保存回执、媒体准备、审批分页/最终交易、保存与审批之间的下架/归档/来源/账号变化、丢失响应恢复及真实表单。不能仅放开 intent 判断，让 live 编辑直接套用现有 draft 保存，因为该路径会取消发布且没有维护已发布行的引用差量。完整 source/product 版本、权限、媒体和事务预算仍由各事务核对，纯图片计划不替代这些检查。

证据位于 output/pricing-clock-repair-2026-10-13/p3e1：live-reference-delta-red-r1 三条预期失败；combination-r3 461/461（引用、原审批和 operation 组合）；Node20 51/51；DB TypeScript、两文件 Biome 和 diff check 通过。前两轮类型错误分别是 kind 联合类型扩大和测试对象索引类型，已修正，日志保留。故障注入把 prepare/read 两处 before 集合均改为空，三个规模的真实差量断言全部失败，退出后逐字节恢复源码并记录 SHA256，见 live-reference-delta-fault-proof.json。其后的私有 rebuildPlan 提取只去掉旧 v1 回执重复解析；最终 combination-final 仍为 461/461，DB TypeScript 和 Biome 通过。

实际复核 catalog-operation-references、对应测试、Root 读/写/取消/恢复消费者、canonical 图片集合、adapter 保存与公开批准版本选择；将“已完成 live 编辑”限定为“完成 live 引用计划契约”，核对函数没有 DB 写入、图片数组副本、SDK 方法或部署配置变更。没有修改云商品或部署。fullDeliveryReady=false。
