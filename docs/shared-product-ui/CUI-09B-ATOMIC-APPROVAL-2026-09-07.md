# CUI-09B.1 — 批准快照的原子保存边界

状态：09B.1 completed-local；09B 整阶段未完成。不部署、不公开新 action。后续 09B.2 候选生产与正式入口仍有依赖。

## Runtime problem

旧本地 rehearsal 已有文件数据库和 schema，但调用顺序仍为：
`clear publication → write each SKU → save product → backfill counters`。
写前校验只能解决输入错误，不能防止中途失败或两管理员覆盖彼此。
本单元新增后端批准原语，**保存批准快照但不改变 published、不修改价格/分类、不发邮件**。
正式公开开关与媒体计数沿用后续发布步骤，不能把保存批准等同于公开。

## Data shape / ownership

- `detailSourceManifest: { revision, variantIds }`：来源完整批次的结束标记，只有 materializer 可写。
- 商品候选 header 与每条候选 SKU 的 `detailSourceRevision` 必须等于 manifest.revision；空数组明确表示无 SKU，缺字段不是空数组。
- 请求 `{ productId, operationId, expectedRevision, expectedDigest }`：标识管理员实际审阅的候选和旧批准版本。
- `catalogDetailApprovalReceipt`：产品上的最后一次批准凭证，记录操作者/请求摘要/操作 ID/服务端新生成的 revision。仅最后一次同请求重试可复用成功；历史请求的旧 expectedRevision 冲突，不回滚新版本。新批准即使重用旧请求 ID 也不能恢复旧公开 revision。
- `catalogDetailPublication`、SKU 的 `catalogDetailApproved/Revision/Position`：仍用现有契约，不另建公开 DTO。
- actorId 必须由认证层传入；事务内重查 users 的 admin/suspended 状态。无公开入口、不允许客户端提交快照内容。

## Technology constraint / verified contract

本会话无 Context7；CloudBase MCP `searchKnowledgeBase` 的 `database/transaction.md`
声明 node-sdk 事务仅支持 doc、不支持 where，最多 100 个操作、30 秒。
已安装 `@cloudbase/node-sdk@3.17.2` / `@cloudbase/database@1.4.3`：
实际 `transaction/index.js` 返回 callbackRes（不是文档示例的 result 包装），冲突重试 callback；
doc.set 为直接数据参数、不能含 _id。沿用现有 NodeSdkDatabase 结构，不扩大手写 SDK surface。

因此不能在事务里临时“分页找全部 SKU”，也不能将任意大小 SKU 集合塞进一个事务。
本单元从生产者封口的 manifest 按 ID 读取；在写之前计算读写操作预算，超过预算整体拒绝，
不截断/只批准第一页。**大量 SKU 的分块不可变快照方案仍待 09B.2，不能将此单元宣称为全目录可上线。**

## Design / flow

事务内：重验 actor → 读取 product/上次凭证 → CAS 旧批准 revision → 读取完整 manifest SKU →
共用 09A 计划及候选摘要 → 对比实际审阅摘要 → 验证并锁定媒体行 → 一起保存 SKU 与 product。
任何异常由事务回滚；确定性失败在第一笔写前返回，不能 catch 后继续提交半份数据。
媒体行必须 active、无 mutation lock；使用事务 set 保持媒体业务数据和 refCount 不变、写入新的私有
`catalogDetailApprovalFence`，确保真正参加写冲突检测，避免同值 no-op 与只读快照的写偏差。
不在事务里发网络请求、下载文件、发送邮件或回填全库计数。
本地 JsonFileAdapter 在已有单文件互斥区对副本执行同一算法，成功后一次原子 rename 持久化。

## Alternatives rejected

- 只做内存 mutex：无法覆盖多个云函数实例。
- CAS 只有 product，不检查 SKU：管理员可能批准自己未看过的新规格。
- 事务外 list 一页/总数：不能证明完整集合且会和来源同步竞争。
- 为通过事务限制截断 SKU：错误改变商品真实数据。
- 直接开放本地 CLI 为云端 action：候选 materializer 尚未在两来源正式管道接好，不能越过依赖。

## Risk / tests

先加测试证明新原语缺失，然后实现：原子成功及文件重开、故障回滚、两个审批仅一个成功、
响应丢失同操作重试、不同请求重用 ID、旧候选摘要、SKU 错绑、缺 manifest/代次、空 SKU、
超过事务预算、媒体删除中/计数异常、停用管理员、未发布状态保持不变。
运行 db/local-server 单元、types/lint、SDK contract gate。本轮无 UI 改动，不将单元测试称为正式浏览器 E2E。

## 接续约束

09B.2 必须接 Alibaba/Excel 完整候选生产者、manifest 封口和大集合路径，然后 09C 正式 Admin/公开路由。
仅本地 materializer 写 manifest 不代表云端来源已经迁移。历史缺 manifest 拒绝新批准但仍能读旧公开快照。
09D 统一资源/配置/正式 RFQ transport 和发布验收；所有部署继续 CI/CD。

## 本轮实现与验收

- `packages/db/src/catalog-detail-commit.ts`：统一批准命令/schema、审阅摘要、事务主体及 CloudBase adapter。
- `DbAdapter` / facade / CloudBase / JsonFileAdapter 接入同一原语；没有无事务的 fallback。
- 本地 materializer 写候选代次和完成 manifest；未改云端 sync/Excel worker 的候选生产。
- 先写测试得到新模块不存在的失败；实现后新增 12 项事务测试通过。
- 本地 workspace 17 项通过（含新增的两来源原子批准、文件重新打开、保持草稿和幂等重试）。
- 写入途中、最终 product 写入、SDK 返回 updated:0 均验证整个事务失败且旧记录不变。
- 补充候选内容、来源代次、published 状态变化时的旧摘要拒绝；批准版本号由服务器生成。
- 全仓 typecheck（含 E2E types）、lint（521 文件）、CloudBase SDK contract gate 通过。
  最终聚焦日志 `/tmp/channel-cui09b-final-cas.log`；完整静态/SDK 日志 `/tmp/channel-cui09b-final.log`。
- 相关后端回归 db 65 / local-server 82 / admin 206 / public-api 76，共 429 项通过，0 失败/跳过。
  日志 `/tmp/channel-cui09b-regression.log`；最后审阅摘要补充后另复跑 12+17 项聚焦测试及 types/lint。
- 按 CloudBase review 技能自审：既有 JWT 认证方式保持不变；新增原语仅接受认证层的 actorId，
  不开放 HTTP 路由；无新集合，无浏览器 SDK/密钥/存储原始链接；set 不传 _id，逐项检查 updated。
  技能包矩阵列出的 NOSQL-007 独立文件未附带，以该矩阵要求及仓库现有 SDK 可执行 gate 核对。
- 无新依赖、无云端写入、无种子库重置、无线上批准/发布、无 git commit/push/deploy。

### 未验证与主风险

- CloudBase adapter 用事务模拟器及已安装 SDK 合同测试验证；**没有本轮真实云端事务验收**。
- 多 SKU 大集合当前明确返回 `APPROVAL_TOO_LARGE`，不能通过忽略尾页绕开。正式全目录发布必须先补大集合路径。
- manifest 的“完整”由生产者负责；本单元校验封口清单/代次，不凭一个数组证明来源库没有其它遗漏行。
- 现有 `approveLocalDetail` rehearsal CLI 仍是旧的本地组合流程；新原语已接入 adapter 并真实落盘验收，
  **尚未接到它或 Admin 按钮**。正式入口必须使用新原语，不能继续暴露该 CLI。
- 正式发布/取消发布/图片引用切换仍归后续单元；此次保存批准不改变公开状态，未宣称整个媒体发布事务闭环完成。
