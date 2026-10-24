# CUI-06D：本地验收、云端回归与启用边界

日期：2026-09-07。工作区 `fix/alibaba-sync-storage-wiring@60b051b`，包含未提交改动；
本轮没有 commit/push。本文记录当前状态，旧阶段文档中的“尚未实现”是历史结论。

## 当前可以确认什么

本地询价不是浏览器假交互：HTTP 请求进入真实 admin handler，再通过共享业务策略和
JsonFileAdapter 的写入锁落盘。云端使用同一策略，但存储由 CloudBase 事务 adapter 实现。
本地文件库和云端数据库是两个隔离的数据存储，本地保存的记录不会自动出现在云端。

- `new` 显示 **Unprocessed**，琥珀色标记；查看、打印或只加备注不会清除待处理计数。
- 管理员显式进入 `in_progress` 后可转为 `waiting_customer`、`completed` 或 `closed`。
- 完成、关闭、重开都需要原因；完成的是销售跟进，不证明订单、付款或发货完成。
- 版本号防止并发覆盖；operationId 保证重试不重复追加历史；历史记录只能追加。
- 请求人、产品、SKU、修订号及报价快照由服务端重新确认，拒绝下架、旧修订和外来 SKU。
- 请求 16 KiB、快照 64 KiB、更新后文档 512 KiB、最多 1000 条历史；超限失败，不截断证据。
- 云端同一事务写入询价及每分钟 30 次的新询价限额；同键重试不消耗额外额度。
- 打印/另存 PDF 只包含询价摘要，排除内部备注。没有发票、订单、支付或邮件发送。

## 本地可见验收

入口：<http://127.0.0.1:4328/admin>，样本 API 端口 3013。
保留测试记录通过真实页面从处理中改为 Completed，HTTP 200，刷新后仍为 version 8，
磁盘为 8 条历史。无原因时按钮不可提交。用户自己的记录仍为 new/version 1，未代为处理。
旧截图的底部裁切已在前一轮定位为测试浏览器固定 viewport；原生窗口滚动可到最后一档报价。

本轮包测试：shared 28、db 53、site 322、public-api 76、admin 206、local-server 75，
合计 760 个通过。新增/更新资源与打包契约测试 22 个通过。
db/admin/public-api/local-server 类型检查通过；Astro 165 文件 0 error/0 warning，8 条既有 hint。
站点构建 15 页通过，CloudBase SDK 合约检查通过。
Node 20.19 下三个独立函数包可冷启动；public-api 另通过真实打包代码、adapter、SDK
查询序列化的离线行为探针。该探针只替换 HTTP 网络层，不注入生产代码，不能作为真实云数据库事务证明。

## 本轮线上异常：发生了什么，为什么测试漏了

GitHub 环境叫 `test`，实际 CloudBase 环境为
`diversity-123-d9grnqfux221323bb` / ap-shanghai，直接服务 supplychainsai.com。
用户确认有条件更新现有 `admin/public-api`，并非新建两个独立云函数。

第一次部署后 `/api/health` 为 200，但 `/api/products` 返回 `FUNCTIONS_INVOCATION_FAILED`。
立即恢复两个函数的原始 ZIP 和原环境变量；旧商品接口恢复 200，响应 SHA-256 与部署前一致。
旧包已在忽略目录 `.cloudbase-artifacts/rollback/cui06d-20260907/` 留存并核验哈希。

调查证据链：

1. 云端旧 public-api 是 `73fd85b420037e1dc15f73cebb11cd2d05c96080`，2026-09-02 构建。
2. 新代码包含既有店小秘变体投影；非空商品页会调用 `attachVariants()` 查询 `productVariants`。
3. MCP 直接检查该集合返回 **Db or Table not exist**，原资源 manifest 也没有声明它。
4. 旧单元测试将未配置集合默认当成 `[]`，只验证导出的旧打包 smoke 也没有执行数据库查询。
5. 使用实际打包文件 + 实际 SDK 的离线 HTTP 探针，缺表时复现
   `collection.count:fail -502005 database collection not exists. Missing collection: productVariants`；
   加入空集合后同一路径通过。官方说明：[集合不存在错误](https://docs.cloudbase.net/error-code/DATABASE_COLLECTION_NOT_EXIST)。
6. 因环境未启用 CLS，旧日志接口又已下线，未拿到那一次云端调用的完整 stack trace。
   根因判断来自部署差异、云端集合实查、可执行复现和修复后对照，不冒充日志原文。

另发现 `function-manifest.test.mjs` 为测试残留 xlsx require，会重新 build/package 覆盖待部署包，
把 releaseId 变成 `local`。改为独立临时目录中的最小坏包；不再碰发布目录。
新 smoke 会在设置 `CHANNEL_EXPECTED_RELEASE` 时调用真实 health 校验版本标识。

配置回滚也有差异：MCP updateFunctionConfig 合并变量，省略新字段不能删除它。
因此显式将 `CATALOG_RFQ_ENABLED=0`，并逐键比较原配置值未变；没有公开任何密钥。

## 修正部署与已验证结果

只补建空的 `productVariants`，ADMINONLY，索引 `productId ASC, position ASC`，核验后重新部署。
另外本轮新建的私有询价集合是 `catalogQuoteRequests`、`catalogInquiryLimits`。
没有启动 Excel worker，没有修改任何已有商品、上架状态、同步任务或邮件配置。

当前两个函数均 Active，Runtime `Nodejs20.19`，releaseId
`cui06d-60b051b-20260907-r2`，buildTime `2026-09-07T03:58:42.295Z`。
该标识指向 HEAD 加本地改动的构建，不是已提交 Git SHA。

| 函数 | 部署 index.js SHA-256 | RFQ 开关 |
| --- | --- | --- |
| admin | `3a22848847252dfb9405be208201b55b25880b09acb83d8861e0507856a8868e` | `0` |
| public-api | `de9f53f7b0f7c6c3be151f9f3c49ec89e300b65cac50a7f6bb2a9e26808bf642` | `0` |

旧商品第一页、第二页、耳机 family 筛选、一个真实单品、Overstock、一个 404 路径、
一个真实图片，7 项状态码及响应 SHA-256 均与部署前一致。
第一页响应 SHA-256：`be3f9fa0473bc4d017efcfc6eb51580eabd9d240622f11bc2056ff399f192f7c`。
新 RFQ 路径在关闭开关时返回 404，不能误提交；admin 健康检查返回正确版本。
匿名 me/inquiryCapabilities/inquiry 均返回 401。用户随后通过正常 Chrome 登录，
真实 Users（9 条）、Products（1081 条）及旧 OEM 列表读取成功，OEM 页面控制台无 error。
未为回归检查修改任何用户、商品或旧 OEM 记录。

## 尚未通过的门，不能混为完成

- 新 Admin 静态前端未上线，本地新菜单不代表线上已显示。
- 登录门已解除：用户已正常登录并完成旧后台只读回归，没有复制 JWT 或用云端密钥伪造身份。
- 真实云端询价 submit → 持久化 → 已登录 admin 查看/处理 → 并发冲突/重读还没验收。
- 云端预检未发现已批准的 `catalogDetailPublication` 快照。必须先规划受控验收数据和公共详情
  发布边界，不能为了通过测试把现有 1074 个未发布商品上架，或把本地用户联系方式复制过去。
- 邮件仍关闭；线上原配置没有 EMAIL_HOST。未发送测试信，没有承诺客户邮件已工作。
- `CATALOG_RFQ_ENABLED` 保持关闭，直到上述闭环和原有后台操作验收完成。
  曾提出单独上线新后台入口和私有测试询价；**用户最新要求停止该方向，先完成本地开发和
  集成测试，再经本分支提交、CI、test 整合统一发布**。没有执行该前端发布或创建测试询价。

## 最新收口决定：不是全部开发完毕，只差部署

2026-09-07 重新 fetch 后：HEAD `60b051b`；origin/wiring `97c645a`，相差 2 个本地提交；
origin/test `73fd85b`；工作区 76 个未提交路径。test 与 HEAD 各有 20 / 78 个独有提交，
不等于这 78 个全是本轮 RFQ 改动；合并前必须核对依赖和差异，不能盲目整体推入 test。

当前正式公共 detail 的云端开关没有接入 index；买家 transport 仍为 DEV/loopback；
云端没有已批准的 detail 快照及 canonical variants 数据。CUI-07/08 及生产快照审核/写入
是实际待办，不能用“本地 760 个测试通过”代替整个发布单元完成。

现有 deploy 脚本原本有 ensureNoSqlResources → functions → frontend 顺序，但资源清单曾缺
productVariants，且本轮手动定向部署绕过了完整流程。两点都必须修正。还需补齐：

1. 本轮发布依赖清单：共享 schema、adapter、集合/索引/权限、数据补齐/审核、函数 action、
   正式 UI 入口、配置开关和回滚边界。邮件、支付、发票、Excel worker 继续排除。
2. 本地完整纵向流程及回归，含 Node 20.19 打包 SDK 行为，而不是只有 require/main 存在。
3. 保存现有脏工作区，按当前分支整理提交；审查和 CI 通过后才整合 test。
4. Deploy Test 与 CI 在 test push 时独立运行；deploy 只跑 test:deploy-smoke，不显式等候
   同次完整 CI。需补同 SHA 的完整测试阻断、版本校验、功能开关与迁移前置检查。
   分支 protection API 返回 404，无法据此判断是否有规则或只是当前凭证无权限。
5. CI/CD 用同一版本执行资源/必要数据迁移预检、函数和前端发布、旧功能回归，再开启 RFQ。
   开始前后均记录状态；不在事务或发布脚本中发送邮件，也不默认发布现有商品。

云端现状保持：两个 r2 函数 Active、RFQ flags=0，新建的三个私有集合为空。
新静态前端没发布；没有云端测试询价、没有改现有商品，也没有本轮 Git commit/push/merge。
不再通过手工部署来继续开发；后续部署/回滚按最新用户规定走受控 CI/CD。
# Follow-up: CUI-06E local verification and release dependency decision

2026-09-07: [CUI-06E](CUI-06E-LOCAL-VALIDATION-AND-RELEASE-GATE-2026-09-07.md)
completed local full-suite and real-handler/file-persistence checks, and added
same-SHA full CI as a deploy prerequisite. Buyer RFQ remains grouped with formal
detail/submit/approved-snapshot wiring. Local CUI-07/08 does not require cloud
acceptance first. No additional cloud action or release was performed.
