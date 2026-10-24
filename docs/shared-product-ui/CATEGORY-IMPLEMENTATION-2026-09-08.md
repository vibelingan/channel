# 分类实施结果与发布边界

日期：2026-09-08。当前分支 `fix/alibaba-sync-storage-wiring`，基点 `60b051b`。
本文件覆盖 09-07 分类计划中的待确认状态；不更改其他 RFQ/UI 工作流的完成状态。

## 已确认范围

用户转述客户基本认可建议归类，并明确工业、车辆、加工服务及其他未确定商品先不处理。
因此执行四个现有栏目：**Headphones / AI Gadgets / Toys / Misc**。
`productFamily` 是商品所属的官网一级栏目，不是 Alibaba 的原始分类，也不新增目录树。

以 09-07 的 1,081 条审计为基线：

| 官网栏目 | 原有 | 本次目标新增 | 应得总数 |
|---|---:|---:|---:|
| Headphones | 720 | 0 | 720 |
| AI Gadgets | 0 | 5 | 5 |
| Toys | 3 | 6 | 9 |
| Misc | 0 | 291 | 291 |
| 待分类 | 358 | -302 | 56 |

**这不是线上执行后的统计。** 本轮 CloudBase 只读请求返回 AUTH_REQUIRED，未重新取得线上快照。
这些数值在依照历史审计清单构造的本地验收库中得到验证；该库明确标注 LOCAL FIXTURE，非真实全量导出。
若发布前数据已变化，必须以新的在线预览为准，不能为凑上述数字强行覆盖商品。
56 件不改、不删除、不标记 excluded，也不代表客户永久拒售。

## 具体实现

1. **持久映射**：复用 `sourceCategoryMappings`，键为 provider=alibaba、taxonomy=alibaba:icbu、sourceCategoryId。
   安装 28 条明确的一级栏目默认规则，另安装 2 条 `reviewRequired=true` 的混合规则，共 30 条。
   ID 固定为 `alibaba-icbu-<category_id>`；已存在不同决定或重复来源键时返回冲突，不覆盖管理员规则。
   原有 5 条耳机映射不动。通用编辑器也检查重复键，禁止更改 Alibaba 规则的来源身份。
2. **有限商品例外**：63708 中 10 件麦克风归 Misc；100001765 中 4 件 AI、4 件 Toys。
   用已确认的 18 个官网商品 ID 加来源 category_id 精确匹配，不在每次同步时用标题猜分类。
   写入时还必须核对 active source、primary source key 及 source→product link。
3. **真实后端操作**：`admin` 新增 `catalogCategories` action；不是新增一个单独部署的云函数。
   现有 admin function 和 local-server 调用相同 handler、Zod 请求/响应合同及事务主体。
   configure 每次最多 10 条规则；preview 按稳定 `_id` 游标每页 100；apply 每次最多 10 件。
   前端位于 Alibaba Sync 页，显式安装规则、预览、应用；挂载页面不产生写操作。
4. **写入保护与恢复**：仅接受明确 `published=false`、未归类、未归档且来源有效的记录。
   请求只携带商品 ID、预览摘要、30 分钟有效期、操作 UUID，目标分类由服务端决定。
   事务内重读当前商品/规则/来源/链接；过期、人工修改、来源换类或错绑都返回冲突。
   商品保存 `catalogClassificationReceipt`（操作者、时间、版本、原来源身份、目标与请求摘要）。
   source/link/rule 同事务增加并发 fence 元数据，不改原始响应对象；任一写入未确认则抛错回滚。
   同一请求重试返回 replayed；前端逐项保留失败项，重新预览只处理剩余未分类项。
   本轮没有通用“批量撤销”接口；业务改类使用现有单品编辑。不可把幂等续跑称为任意历史回滚。
5. **发布与同步**：归类不改变 published、图片、价格、标题或公开快照。
   缺少合法官网一级分类时，现有后端发布校验拒绝；不是仅禁用前端按钮。
   已有产品的官网分类由管理员负责，普通同步不会覆盖。移除旧 materialize 重试中的无条件分类回填，
   由本次带预览和事务检查的动作接管历史回填，避免覆盖并发人工修改。
   `alibabaClassifiedCategoryId` 记录确认分类时的源 ID；供应商改类后保留原官网分类，编辑页提示确认，
   后端阻止再次发布，管理员明确提交 Product Family 后更新确认基线。不会擅自下架已有公开商品。
6. **未来新数据**：新商品用已持久化默认规则归类；未知/混合类目进入待分类，管理员补好后才能发布。
   来源 `category_id` 已在 product.get 正常数据中，无额外分类 API 请求。
   每一批次按 distinct category ID 懒加载并缓存数据库映射；新批次重新读取，无长期陈旧缓存。
   Excel 共用映射解析也遵守 reviewRequired 和重复键拒绝，保持 provider/taxonomy 隔离。

## 本地证据

- 策略边界、事务主体、云端 adapter SDK 回执/失败回滚测试。
- 真实 admin handler + 文件 DB：1,081 条跨页，302 件落盘，56 + 723 件逐字段不变，重开数据库保持结果。
- 同一操作并发重试仅应用一次；请求伪造目标、过期摘要、来源改类、链接被删、映射被改、发布商品均拒绝。
- 真实 lease-fenced source 更新保持官网分类；发布被拒绝；显式确认分类后更新基线且仍为草稿。
- shared 36、db 72、admin 207、Alibaba worker 120、local-server 85、site 331、public-api 76、catalog-import 287，
  合计 **1,214 项相关测试通过，0 失败**；不是全仓所有脚本/E2E 的计数。
- 相关后端 TypeScript 与 Astro 检查无错误（Astro 8 条已有提示）；修改范围 Biome、git diff --check 通过。
  admin/Alibaba function bundles 和 site build 通过；未执行远端 CI/CD。
- CloudBase SDK contract verification 通过。核对安装包 node-sdk 3.17.2 / database 1.4.3：
  transaction set 插入可返回 updated=0 + upserted，因此不能仅检查 updated=1。
  依据官方 [事务文档](https://docs.cloudbase.net/database/transaction) 及安装包源码；Context7 不可用，另查官方 MCP 文档。

## 现在还没做什么，下一步是什么

- 没有 push、merge、直接部署、云端回填或商品发布。当前工作区还有同工作流此前的未提交变更，不整包盲提交。
- 没有改 Alibaba/店小秘的分类，不需要客户现在逐件修改。56 件暂不处理不阻挡已确认范围的分类发布。
- 下一步先收口分类发布单元及其 shared/db/admin/worker/site 依赖、审查与 CI；通过后整合 test，统一 CI/CD。
  当前 test 共用 supplychainsai.com，不能经 MCP 单独换函数。使用已有 NoSQL 集合，无新集合/RLS 变更。
- 部署后正常 Admin 登录：安装规则 → 新鲜预览 → 核对冲突/候选 → 分批应用 → 数据库重新计数与抽样。
  若额外出现待处理商品或冲突，保留并报告，不覆盖；线上验证完成后才能关闭“分类发布”阻断。
- 正式新详情、询价公开入口及 09B 等后续工作仍按原发布依赖推进，不在本轮冒称完成。

## 浏览器验收与本地入口

- 本地 `http://127.0.0.1:4330/admin` → 正常登录 → Alibaba Sync → 安装规则 → 预览 → Apply 302。
- 实际状态显示 `302 product classifications saved. 0 remaining. No products published.`。
  独立读取文件数据库确认 302 条分类回执、其中 published=true 为 0、分类总数与上表一致。
- 图像证据：工作区 `.playwright-cli/page-2026-09-08T08-56-23-489Z.png`；只含本地界面，没有真实 Token。
- 浏览器核查发现旧 Products 标签曾显示 Other Electronics & Toys，已统一到共享 Admin 标签常量 Misc，
  并更新桌面/手机既有测试期望。存储枚举仍是 misc，不进行字段重命名迁移。
- 独立验收库 `apps/local-server/data/category-20260908/db.json` 已被 gitignore 排除；
  前端 4330、后端 3008，与此前 4328 商品预览无关。该库用来验收分类，不是新商品详情真实媒体样本。
- 按 CloudBase code-review/verification 技能检查了认证门、既有集合、SDK 回执、失败恢复及前后端状态。
  本项目使用已有 JWT + 服务端角色复核，不把 CloudBase Web Auth 的 getSession 建议误用于自有认证。
  遵循用户禁止派发要求，本轮未派子代理；自行对照需求和实际差异检查。
