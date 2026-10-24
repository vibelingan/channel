# P4c9d：有时间预算的 live 保存和审批继续

本单元开放 refresh-live 的后端 owned workflow，沿用 C9b/C9c 的同一个任务。编辑 UI 尚未切换，未部署到 test，也未改真实商品；fullDeliveryReady=false。

继续请求先认领新增照片，再绑定和分页处理最多 63 个原始图库/描述图差量。每个阶段检查父请求剩余时间，默认请求预算为 12 秒；预算耗尽返回原 reserved 状态及小型 saveReferences 进度，不把部分处理说成保存失败，也不提前写商品。下一次继续仍用原冻结输入。原照片锁在保存后释放；停止和失效恢复沿用已有原子取消流程。这里的时间预算限制下一步的启动，不能中断已发出的数据库事务，不是云端延迟上限承诺。

满 80 个 pending 槽时，返回有界 referenceRecovery 游标。下一次请求可以从原游标继续检查，不反复只看前三个占位者。游标只供寻找候选，回收资格仍由原事务重新核对。保存阶段的等待只允许当前、未取消、未过期且未完成的 refresh-live reserved 任务；原审批阶段的等待条件继续严格检查。DTO 不含私有 Root、原输入、来源或图片数组，仍受 4096 bytes 限制。

保存确认后，seed、配置页、媒体准备、引用页及最终提交均允许 refresh-live，继续复用各自的 native 校验。旧批准版保持到最终原子提交；新图片必须经过真实字节和保护流程。并发下架后原任务不能重新发布，停止也不撤回已保存的编辑。

本地证据在 output/pricing-clock-repair-2026-10-13/p3e1/live-continuation-*：

- 初始 4 条有效需求测试在旧实现均失败，开放 live 保存和扩展有界状态后通过。
- 11 文件组合回归 1270/1270，0 跳过；覆盖旧草稿、首次发布、保存/审批事务，以及新 live 路径。
- 新共用存储契约覆盖 63 个差量分段续跑、claim/bind/page/开始前四个预算边界、满槽游标从 3 到 6、分页已提交但回复 BUSY、原 ID 重试。实际 JSON mutex 另外验证并发同 ID 续跑只产生一次业务更新；CloudBase 仍是实际 adapter 的 SDK 事务模拟，不算云 MVCC 验收。
- 实际 Admin handler、真实 PNG 和实际媒体 worker 覆盖手工/105 配置的 save→prepare→approval→public readback；批准前保留旧买家版本，完成后旧图 404、新图 200。另有保存/最终审批回复丢失后的恢复、父预算在 claim 后耗尽、已保存后并发下架和停止。
- Node20 运行状态契约和两份实际 JSON/HTTP 测试，共 81/81，0 跳过。DB/local-server 类型、Admin 实际构建、11 个 TS 文件 Biome 和 diff check 通过。
- 故障注入移除最终保存前的预算检查，JSON/CloudBase 两条 page-deadline 测试均失败；finally 恢复源码且 SHA256 一致。

第一次组合测试 1268/1270：一个新测试用未更换的图片断言存在新增照片锁，另一个把内容修改断言成 lifecycle 版本递增。修正前者为真实新 PNG，后者检查实际 content generation；未放松生产校验。修正后第二轮 1270 全通过。保存回复丢失测试预期产生一次 handler 的 unknown-error 日志，读回原 saved 回执后继续，不把未知回复直接当成功。

实际复核 workflow、Root/native 保存守卫、seed、Admin continue/media/reference/final、共用 DTO 及 JSON/CloudBase 调用点和测试。文案把“12 秒完成”改为“12 秒预算控制下一步启动”，避免把本地构建或真实本地 PNG 说成云验收。无 SDK 方法/shim、配置、环境、集合、部署变更。编辑 UI、真实 compiled-worker 制品组合、历史修复审计及 test 三时钟/20 件发布恢复/COS/MVCC/性能仍需完成；原 JSON80 和 WebKit 诊断缺口继续保留。
