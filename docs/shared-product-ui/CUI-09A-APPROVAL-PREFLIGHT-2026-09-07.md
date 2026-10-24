# CUI-09A — 共用批准计划与写前校验

状态：completed-local。接续用户批准的正式接线阶段；不改变页面、不部署、不审批现有数据。

## 本次可独立验收的范围

当前 `approveLocalDetail` 在 CLI 中同时组装批准内容和写库。publication 的跨字段
校验却发生在清空旧 publication、写完 SKU 之后；坏的小标题数据可能导致批准失败，
但旧页面已不可读。候选 header/variant 中的 ID 也没有与所属数据库行在写前核对。

旧风险形状：

```ts
await updateDoc('products', productId, { catalogDetailPublication: null });
// write variants first
const publication = CatalogDetailPublicationSchema.parse({ ... });
```

先提取纯函数 `planCatalogDetailApproval`，输入已读取的 canonical product 与完整
source-owned active variant 行、调用方生成的 revision，输出经过现有 shared Zod
契约验证的 publication、按顺序的 variants、图库 ID。此函数没有 DB、SDK、发布权限
或 provider 分支；调用方仍负责完整读取、权限、图片就绪和真正持久化。

生命周期：输入是单次批准请求读到的当前候选和人工编辑值，输出是该次 revision
的写入计划；不缓存、不新建持久化集合、不修改源 observation 或私有 Evidence。
shared 已有 Zod 3 和 DTO，本次没有增加库，也没有修改第三方 SDK 接口。

目标顺序为 `read all rows → planCatalogDetailApproval → check media → write`。
`publication` 与 `variants` 从同一计划返回，不再写完才验证跨字段约束；Zod 输入
对象仅选择必需字段，输出沿用 strict 公共 schema，不散播整条私有 DB 行。

规则：

- product 的 sourceReady、未归档状态、header ID 必须正确。
- 每个选中 SKU 的 productId、source owner、candidate ID 与数据库行身份一致；
  不允许重复 ID、不完整/已移除/归档 SKU 或坏 position。
- 编辑后的名称、描述、SKU、选项、图库沿用现有人工优先语义。
- 人工描述不同于源描述时不再采用源结构化内容；未改描述时对 content/noteBlocks
  完整校验，不能为了批准成功而静默丢弃错误内容。
- SKU 图必须位于产品图库内；继续沿用现有媒体引用生命周期。
- 所有输出校验必须早于第一笔写入。非法输入不能更改已有批准版本。

不选方案：直接把 CLI 暴露成云端 action（有部分写入窗口）；在前端重复校验代替
后端边界；新建第二套详情 DTO；本次顺便新增云端集合/迁移或自动批准同步内容。

## 测试和执行顺序

1. 基线：现有 local workspace 14 项通过。
2. 先增加真实 JsonFileAdapter + public detail handler 回归：坏 noteBlocks 的批准
   失败保留旧版本；伪造另一商品的 candidate ID 不得改写那一行。
3. 纯函数覆盖 null/空/坏输入、跨商品/owner/ID、重复 SKU、空 SKU 集合、稳定顺序、
   未改描述的小标题契约、人工修改后的内容失效、图库从属及输入不变性。
4. 本地 CLI 使用共用计划；图片就绪检查保留在调用方；跑 shared/local-server 回归、
   typecheck/lint。全部只操作临时测试库，不重新 seed 用户样本库。

## 接下来的耦合工作（本次不宣称完成）

09B：正式批准持久化，完整候选版本、并发保护、失败恢复、媒体引用与旧版本切换。
必须先审查现有 CloudBase SDK/事务及真实两种 materializer，不能把此纯函数当作事务。
09C：批准操作的 Admin 入口和正式公开详情/列表入口，未批准或开关关闭保留旧行为。
09D：正式 RFQ transport、资源/配置/迁移预检与整个正式路径的本地验收。
这些一起完成后，才进入本分支提交、审查、同 SHA CI、test 合并及 CI/CD 发布验收。

本地 rehearsal 暂时仍有非原子多行写入；本次只消除可在写前发现的校验失败窗口，
不声称解决进程中断/并发写入。云端 flag 的历史记录不是本轮实时检查结果。

## 本轮实际验收记录

- 写前新增两个真实存储回归，旧实现分别得到 `404 !== 200` 和
  `Missing expected rejection`；修复后 workspace 全部 16 项通过。
- 新增 8 项共享策略测试；首次边界检查还捕获 ID 被 trim 后接受，已改为拒绝
  首尾空白而不是改变身份。空 SKU 数组是显式有效输入，未把它误算成坏输入。
- shared 36 项、local-server 81 项通过（0 失败、0 跳过）；Node 22.13.0 复跑
  同样 117 项及两个包的 typecheck 全通过，命令退出 0。
  命令：`NODE_OPTIONS= pnpm --package=node@22.13.0 dlx -c 'pnpm --filter @vibelingan-channel/shared --filter @vibelingan-channel/local-server test && pnpm --filter @vibelingan-channel/shared --filter @vibelingan-channel/local-server typecheck'`。
  本机日志：`/tmp/channel-cui09a-node22.log`。非本轮全仓单元/浏览器重跑。
- 全仓 `pnpm typecheck`（含 E2E types）、`pnpm lint`（519 文件）通过。
- 页面和真实本地详情 HTTP 均为 200；样本库计数为产品 4、SKU 21、询价 2。
  本次没有重新 seed、调用 approve CLI、写用户记录、云端请求、提交或部署。
- 本次自审对照工作区既有未提交内容，保留之前的结构化内容提取和其它 RFQ 改动。
  按用户约束未派发独立 reviewer；正式发布仍须分支审查，不把自审当独立审查。

自审剩余边界：函数无法仅凭一个数组证明调用方已经读取完所有数据库页；目前本地
调用方使用 `variantsFor` 完整分页，正式调用方必须携带并核对候选版本/数量。
对已归档/已移除/其它 owner 行的选择仍由读取边界负责。这些选择和媒体就绪检查
之后若发生并发变化，本地多行写入没有事务保护，因此不可直接开放为线上批准 API。
