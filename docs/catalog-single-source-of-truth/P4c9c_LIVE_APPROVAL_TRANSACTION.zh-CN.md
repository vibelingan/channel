# P4c9c：已发布商品的内部重审批

本单元把 refresh-live 的 native 审批接到 P4c9b 的同一 saved Root。HTTP 继续流程、时间预算和实际编辑表单尚未切换；fullDeliveryReady=false，未部署、未变更真实商品。

begin 保留 liveSaveReferences，并在重复 begin 的审批内容比较中剥离这份保存元数据。saved 的引用 commit proof 必须仍存在。审批、图片差量页和最终提交均要求商品仍已发布、未归档，且原内容、分类、来源、版本和账号有效。refresh-live 最终提交使用当前发布状态，不重新写一次“设为发布”的意图；它不能把并发下架的商品重新上线。

每次图片分页和最终写入都在事务中读取当前商品，重建更新前后 canonical 图片集合并验证原差量和完整前缀。live 额外读保存证明，分页预算从预留 8 次改为预留 9 次，仍受 98 次上限约束。新增图片继续要求已存储且已验证像素。负差量只撤销原公开引用，可以移除字节损坏的旧批准图片；普通首次发布和任何正差量继续拒绝这种图片。计数为零或异常锁仍拒绝。

成功后旧集合已经不在商品上，历史读取因此只从原摘要读取证明身份，再核对原子提交的完整终态 proof。它不返回写入计划，也不能授权图片或商品写入。live 的历史进度只做有界形状/绑定检查；实际写入另外重算前缀，损坏前缀会拒绝。取消 staged 任务也使用原证明身份：即使商品已经下架、归档或来源变了，也能停止未完成审批并保留当前业务结果。旧 draft v1 的完整重建校验保持。

本地验证：live-approval-combination-r1 1084/1084、0 跳过，覆盖原保存、审批、引用、两个 adapter 及新增路径。live-approval-node20 376/376、0 跳过；DB/local-server 类型、5 文件 Biome、Admin 实际构建和 diff check 通过。证据位于 output/pricing-clock-repair-2026-10-13/p3e1。

新增核心场景包括 0/105 配置、21 张新增配置图跨页、旧坏图 -1、继续使用图片不重复 +1、空差量终态、完成后的历史读取/丢失回复，以及下架、归档、编辑、分类、来源、失权和损坏前缀后拒绝审批并可停止。共用存储契约还实际执行 native 行保存→照片释放→手工来源准备→同 Root 审批→最终提交，最后证明写失败时商品/Root/计数均回滚，重试只提交一次。CloudBase 部分仍是 SDK 事务模拟；媒体部分明确使用 metadata lifecycle fixture，未验证真实 PNG/COS 或云 MVCC。

最初 red-r1/green-r1 的新 live 样本缺有效图库/描述，先被发布校验拒绝；修正样本后 green-r2 通过，再补齐跨页/异常场景。native-r1 的媒体样本 byteSize/checksum 与既有 helper 固定 123 bytes 不符，未放松校验，修正 fixture 后 native-r2 两端通过。为避免把样本错误当作需求红测，另外恢复三份生产源码到 f5de2e49 基线运行最终有效测试，5/5 均在 live begin 返回 CONFLICT；finally 恢复并核对三份哈希，见 live-approval-baseline-proof.json。

故障注入另将最终写入前的重算前缀换成直接信任历史前缀，stage-prefix 反例实际失败；恢复源码并核对 SHA256，见 live-approval-fault-prefix-proof.json。这证明历史读取的放宽不能直接传入写入许可。

实际复核 Root 解析、历史证明和写入计划的消费者、begin/分页/媒体/最终提交/取消/恢复、stage helper 的所有调用点、原生事务 adapter 及两端契约。没有新增 SDK 方法、shim、集合、环境或配置。文案把“已接完 live 编辑”改为“内部重审批完成”，并保留真实媒体、HTTP 时间预算、编辑 UI、完整流程矩阵及 test 真实验收门槛；原 JSON80/WebKit 的原始诊断缺口继续保留。
