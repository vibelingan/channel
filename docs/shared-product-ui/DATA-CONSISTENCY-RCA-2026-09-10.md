# 商品数据一致性审计：根因与整改边界

状态：整改已通过 PR #43 合入 test，并由 CI/CD 发布同一版本 `5678d047`；线上公共浏览器 60 项通过，1,074 件来源数据重放已落库。认证闭环发现的测试等待问题及追加验收见下方记录。
日期：2026-09-10。范围：Alibaba 原始响应、列表/编辑、草稿 Preview、审核发布、正式详情。

## 结论

不是简单的 React state 没共享，也不是整个项目没有公共模块。
实际问题是来源适配不完整、新旧商品读模型同时存在、价格规则重复实现，
再加上验收从已经转换好的数据开始，未覆盖供应商原始数据到最终页面的内容完整性。
不能再把“共用组件”“Zod 校验通过”“正式流程 E2E 通过”作为完整数据接入的证明。

本次露营灯并没有证实“同一个版本在官网正常，只有 Preview 错误”。
前面正常的耳机/人工价格样本与本次批发露营灯不是同一个产品和同一种源格式。
露营灯的线上公共来源记录本身已经丢失内容，Preview 忠实显示了不完整结果。
详见 [真实 raw 重放证据](DRAFT-PREVIEW-ACCEPTANCE-2026-09-10.md)。

## 已有复用与真实分叉

| 入口 | 实际依赖 | 判断 |
| --- | --- | --- |
| 后台列表/编辑 | `products` 旧字段、`alibabaCatalogPricing`、`alibabaSourceReview`；`admin/api.ts` 请求层 | 有共用请求层，但读取兼容摘要，不是新详情对象 |
| 新草稿 Preview | `prepareDetailReview` → `catalogSourceObservations` → candidate → `planCatalogDetailApproval` → `CatalogDetailView` | 与正式详情共用 `CatalogDetail`、`CatalogQuotePanel`、规格组件 |
| 正式新详情 | `catalogDetailPublication` + 同 revision 的 `catalogDetailVariants` → `CatalogDetailView` | 只读批准版本合理，不能把未审核源数据直接公开 |
| 人工价格决策 | `shared/catalog/resolve-pricing.ts` 的 `resolveManualCatalogPricing` | 本轮已收口；列表/编辑与审核调用同一规则，后者仅转换 DTO |

同一商品保留 raw、草稿、已发布快照，是证据恢复及审核隔离的需要；
它们不能是各页面独立解释、随意 fallback 的多个“事实来源”。
列表摘要可以汇总多个 SKU，但必须说明范围；不能与已选 SKU 的报价冒充同一个数。

## 三个根因

### 1. 来源转换遗漏变成了合法空状态

- `alibaba-contracts.ts` 未抽取 `wholesale_trade.price` 和商品级 attributes。
- `alibaba-observation-adapter.ts:274` 明确写入 `identity.attributes: []`。
- 图片型描述经文字清洗变成 placeholder，未建立描述图片的独立媒体投影。
- `alibaba-normalizer.ts` 的 unavailable 路径丢掉已知 MOQ；降级原因未进入清晰的业务状态。

Zod 只能证明结果符合现有允许空值的 schema，不能证明 47 条源属性得到保留。
防止无效价格进入公开报价是正确的；把“不支持/解析失败/确实未提供”都当成无数据则不正确。

### 2. 统一迁移没有收口

旧模型的标量价/Alibaba 摘要仍服务列表和编辑，新模型的 offers/websitePricing 服务详情。
`adminSourcePricingFallback` 又允许后台在旧摘要缺失时读取来源 review 作为补充。
这能解决个别可见性问题，但不是一套统一的有效价格决策。

本轮实际差异复现：同一个 `catalogPricingMode=manual, unitPrice=1.234` 输入，
`resolveCatalogPricing` 接受并返回标量价；`planCatalogDetailApproval` 拒绝，
报 `Website price has unsupported precision`。这是重复业务校验已经发生分歧的证据，
不是对客户当前记录的价格认定，也不是本次露营灯的直接根因。

### 3. 测试覆盖范围与交付表述不匹配

`tests/fixtures/prepare-catalog-pricing.ts` 直接构造合法 observation、价格及摘要写入本地 DB。
`tests/e2e/catalog-formal-journey.spec.ts` 确实使用正式 handler，能测审核、页面、权限、滚动等，
但这条测试绕过 Alibaba 原始响应解析。它不能发现只有 raw 内存在的批发价、商品属性、图片描述。
`alibaba-observation-adapter.test.ts` 的主要 fixture 也从已经抽取好的 draft 开始，显式提供 USD。
因此必须区分流程 E2E、源数据契约测试、真实内容一致性验收，不能用其中一项替代另外两项。

## 整改方案：集中业务规则，不堆新组件

1. 完善现有两个 provider adapter 的公共 contract；raw 只由来源适配层解释。
   MOQ/计量单位独立于价格可用性，描述图片独立于主图；保留多值属性、来源与质量状态。
2. 把金额校验、人工覆盖优先级、数量适用条件集中在现有 shared 业务模块中。
   列表摘要、编辑器预览、审核快照、详情和 RFQ 快照通过该实现生成结果。
   旧字段仅在迁移兼容 adapter 中读取，禁止在各组件继续新增价格 fallback。
3. 保留 admin/public 两个权限入口；统一内部生成规则与返回值语义，不混用草稿与公开数据。
   明确 product、revision、SKU、数量、币种及价格依据；缓存键也必须包含相应范围。
4. 展示组件只接收计算好的价格/规格/媒体模型，不各自请求、不再猜价格来源。
   编辑器保留未保存表单状态，提交明确覆盖命令；保存后使对应草稿缓存失效。
   不把草稿、公开版本、临时表单塞进一个不分权限/版本的全局对象。

这里“不各自请求”指不让每个价格/图片子组件重复获取整份商品；不是禁止页面容器刷新 API。
后台现有 TanStack Query 用于列表/询价等服务端状态；新详情选型/表单使用 React state，
部分 Preview 使用 effect。复用现有请求层，缓存必须区分草稿与批准版本，不能跨权限共享。

## 状态管理分层说明（2026-09-10 发布前复核）

| 层 | 当前用途 | 不应该承担的职责 |
| --- | --- | --- |
| TanStack Query | 后台列表、询价等服务端数据的请求/缓存/失效 | 不把未保存表单当成已落库数据，不跨权限或草稿/发布版本复用结果 |
| React state | 选中配置、步骤、弹窗、商品编辑器的未保存 patch | 不另存一份可独立编辑的最终报价；可推导内容应由输入计算 |
| React Hook Form | RFQ 联系字段、错误、dirty/touched 与表单提交 | 不与另一份 React state 双向镜像相同字段；不是服务端商品缓存 |
| Context | 传输能力和预览上下文依赖注入 | 不再复制全局商品/报价列表；Context 本身不是请求缓存 |

这种组合是职责分层，不是四套竞争的数据源。TanStack 官方明确区分 server state 与
client state，React 官方建议避免重复与可推导 state。当前 AdminDetailPreview 还使用
局部 effect + AbortController 管理审核读取，不应声称所有服务端读取都已迁入 Query。
它调用共用请求层，且取消旧请求防止商品/分页切换后旧结果覆盖；没有为了本次修复引入新状态库。
[TanStack 的职责边界](https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state)、
[React state 结构原则](https://react.dev/learn/choosing-the-state-structure)

例如来源报价 7.67，管理员正在输入人工价 8.50：此时草稿仅存在编辑器，列表和官网不应
提前变成 8.50。保存成功后刷新对应后台记录；公开详情仍依据批准版本。批准人工覆盖后，
网站统一用 8.50；下次来源同步即使变成 7.80，也不能覆盖人工价。这里价格值为说明用例，
不是本轮给任何线上产品新增价格。原始解析缺失与缓存过期是不同问题，不能混称为 state 冲突。

## MIU DC-01 — 原始响应到公共商品的完整性

### Runtime Problem
商品同步成功但 Preview 缺少属性、MOQ 和图片描述。
`identity.attributes: []` 与 `unavailablePricing(context)` 的最小对象丢失已有来源事实。

### Data Shape
来源 JSON 永久作为私有恢复证据；observation 为可重建草稿；批准快照为公开固定版本。
`start_quantity: -1` 是无效阶梯边界，不得改写为 1；`wholesale_trade.min_order_quantity: 1`
是独立商品条件。商品级报价不自动冒充 SKU 报价。商品属性保留同名多值，规格与 SKU 选项分开。

### Technology Constraint
允许空的 Zod 只能校验形状。HTML 清洗必须保留安全边界，不可为保留图片直接渲染供应商 HTML。
图片来源证据与获准对外提供的本站图片 ID 分开；详情图不占用九张主图的配额。

### Design / Flow
持久 raw → lossless extractor → normalizer/observation → 绑定媒体的候选 → 审核快照 → 同一详情组件。
异常报价保留 MOQ 和 warning；使用官方 wholesale USD/两位小数约束，仅容忍可证明的序列化尾噪声。

### Best-Practice Fix
扩展现有 adapter，不加组件私有价格规则；`{mode:'unavailable', minimumOrderQuantity:1}`
表示未知价格而非未知采购条件。复用已安装的 parse5 提取图片 URL，仍不执行源 HTML。

### Alternatives Rejected
不修改 -1 为 1，不为所有缺币种字段默认 USD，不把 17 张详情图塞进主图，不刷新已发布内容绕过审核。

### Code Translation
`unavailablePricing` 保留 `sourceMoq`；属性从 `attributes.product_attribute` 转成数组，
不以属性名称建覆盖式 map。价格和描述的异常通过 observations warnings 保留，而不是静默填空。

### Risk / Test
测试边界沿用用户批准的 raw→adapter→候选/审核及浏览器旅程。
`alibaba-raw-completeness.test.ts` 的 MOQ 测试已先失败，再修复通过。
已覆盖同名多值、批发价格精度、图片型描述和恶意图片 URL。

## MIU DC-02 — 人工价格规则收口

### Runtime Problem
`resolveCatalogPricing` 和审核中的 `websitePricing` 重复定义优先级，1.234 被前者接受、后者拒绝。

### Data Shape
人工表单为未保存 patch；数据库人工字段是显式覆盖；source observation 不受人工覆盖改变。
以分为单位的金额和合法 MOQ 是共同约束；人工模式缺价不得悄悄退回来源价格。

### Technology Constraint
兼容字段仍需读取，不可因新 UI 已上线就删掉客户输入；请求缓存不能修复不同业务决策。

### Design / Flow
共享人工价格决策 → 列表/编辑的价格 resolver 与批准快照转换 → 详情/RFQ。

### Best-Practice Fix
把优先级、精度、无效覆盖状态集中为一个函数，两个调用方只转换展示格式或返回明确错误。

### Alternatives Rejected
不复制一份最新金额到全局 state；不以“用最新 API”为由在公开详情读取未审核草稿。

### Code Translation
调用方根据共享决策的 `source/manual/invalid` 状态行动，不再独立判断 wholesalePrice/unitPrice。

### Risk / Test
同一份输入覆盖 1.234、0、非法/空人工阶梯、source/manual 模式、MOQ；两个边界必须一致。
## 实施与验收结果（2026-09-10，本地）

源格式矩阵补测试：sourcing/wholesale、正常阶梯/负哨兵、缺币种/官方固定币种、
   小数噪声、无价但有 MOQ、多值/冲突属性、纯图片/混合/空描述、人工覆盖与重新同步。
   流程测试应至少有一组从脱敏 raw → 真实 adapter → 本地 DB → 草稿/编辑/审核/公开详情，
   对同一版本/SKU/数量的语义逐项比较。模拟网络失败仍合理，但不能模拟掉被测的数据转换。
使用已有 raw 做带版本、可恢复、幂等重放，保护人工覆盖和当前发布状态。
   修复代码不会自动修复已经落库的空记录；重放和重新审核属于明确的交付步骤。
   部署仍走同一版本 CI/CD，不单独通过 MCP 更新云函数。

| 原始来源事实 | 唯一转换与保存位置 | 消费边界 |
| --- | --- | --- |
| 47 条商品属性 | extractor → observation.identity.attributes，保留同名多值 | candidate.facts → 共用规格投影；样本 30 条明确规格 + 17 条多值说明，不冒充 47 个互不冲突的规格 |
| wholesale_trade.price / MOQ | lossless normalizer → product-scoped offer，USD 767 分 / MOQ 1 | 列表摘要和详情保留商品报价范围；不复制为 SKU 报价 |
| SKU start_quantity=-1 | unavailable + MOQ 1 + invalid-source-pricing warning | 不生成假阶梯，不把库存 1000 当起订量 |
| 6 张主图 | content.media → source links → imageIds | 复用 Gallery，最多 9 张 |
| 17 张图片型描述 | content.description.imageUrls → descriptionImageIds | 共用 CatalogDescriptionImages，最多 18 张，独立于主图配额 |
| 人工价格 | resolveManualCatalogPricing → editor/list decision / approval DTO | 同样的 1.234 在所有边界均为无效，不覆盖真实 raw |

独立复核不只使用脱敏 fixture：本轮还将本机保留的 10,777 字节原始响应重新送入当前真实 parser /
adapter，实测得到 47 条属性、6 张主图、17 张详情图、3 个 SKU 选项，商品报价 USD 767 分 / MOQ 1，
SKU 报价 unavailable / MOQ 1；warnings 为 description-sanitized 与 invalid-source-pricing。
这是对已保存 9 月 3 日响应的本地重新解析，不是新鲜 API 调用，也没有写回云端。

图片 URL 由已安装的 parse5 提取，不执行源 HTML。超长/非法 URL 和解析配额会产生 warning；
最终发布必须经过原有下载、所有权、MIME、媒体状态与引用计数检查。仅有外部 URL 不足以发布。
纯图片描述允许发布的条件是已有合法、已保存、可用的 descriptionImageIds，不能仅因正文为空拒绝。
来源为 batch / 非 Piece 的批发价暂不解释为每件价格；保留 evidence 和不可用原因，未实现换算。

Preview 的 detail 与媒体 ID 来自同一次已校验的 review 读取，不再混用最新详情和旧列表行的媒体。
私有媒体共用 hook，去重后最多 3 个并发请求；Blob URL 在切换/关闭时释放。失败显示重试入口，
不悄悄回退到另一张来源图。公开详情仍读批准 revision，不能因为预览较新就绕过审核。
新客户端请求 `view=sections-media` / `includePreviewMedia=true`；旧客户端保持原 strict 响应字段。
这是兼容部署期间已打开页面的保护，不是允许前后端任意版本混发。

验证：包括图片全部替换事务配额回归在内，全仓 1,506 项测试通过；全仓 typecheck、受影响源码 lint、CloudBase SDK contract、
重新打包的三个云函数离线 cold-start / public legacy-read / missing-collection 负对照通过。
Node 25 本地测试使用 `NODE_OPTIONS=--no-experimental-webstorage`；CI 的 Node 22 / 云端 Node 20
结果必须由 Actions 单独确认，不以本机版本代替。全目录 lint 的唯一问题是未跟踪的原始证据 JSON
格式；保留其原始字节，不把证据文件格式化或纳入发布。
正式浏览器套件为 41 项 public + 19 项 catalog + 4 项正式链路；包括脱敏 raw 经真实 adapter / DB /
handler 后的草稿、编辑、Preview、批准、公开详情，以及 RFQ→Admin 跟进。图片二进制为测试像素，
证明授权/绑定/数量/布局，不冒充真实 CDN 下载质量。最后串行重跑 64/64 全部通过。

测试先后发现并修复了两项额外缺口：纯图片描述误触发“必须有正文”发布校验；新增媒体字段
破坏旧 strict 客户端。两项均先红后绿。一次并行构建碰撞导致 Astro 临时 prerender 文件缺失，
已转串行复验；不是功能测试通过，也不修改业务代码掩盖构建问题。

发布复核补充：图片换版事务需要 5 个固定读写 + 每个旧/新关联图片 2 个操作。
46 个不同关联图片可原子完成；47 个及以上在写入前拒绝，保留原批准版本，并明确提示把主图
与详情图的替换分两次保存/批准。不能笼统提示“图片缺失”，也不能超出 CloudBase 事务配额后部分写入。
回归覆盖 46 个图片成功（97 次操作）与 47 个图片整批不变。

完整编辑器浏览器回归又捕捉到复用组件的两个缺口：详情图上传入口仍叫“Add product images”，
与主图入口重名；提交 handler 已阻止上传时保存，但 Save 按钮还漏读 descriptionImageBusy。
现有 ImageManager 增加 gallery/description 用途参数，详情图不显示 Primary；Save、关闭和提交
统一使用同一 mediaBusy 状态。新增描述图上传中不可保存/取消/Escape、完成后恢复的独立用例。
首次 PR CI 因重名入口失败，不能把该次 CI 当作发布许可；修复后必须以新 head 重跑。
修复后的非正式详情开关验收流程为 77/77（含 10 个编辑器/分类标签用例），正式流程为 64/64；
公共页与 catalog 的 60 项重复执行，合计 81 个不同浏览器用例。最新提交的 CI 状态以 PR #43 为准。

## 发布与存量修复顺序

1. 当前分支提交 → PR 完整 CI（包含正式 E2E）→ 合 test 后相同 SHA 的 Deploy Test；
   公共 schema、Admin、public-api、sync、前台同批。禁止直接 MCP 部署。
2. 对照发布 SHA / 资源预检 / 旧列表 / 新详情 / Admin 回归，再运行现有后台
   `replaySourceObservations` 的 validate。版本为 `alibaba-content-pricing-v2`，旧 dry-run hash 不可复用。
3. 仅在全页 manifest、raw hash、总数和 lease 均有效时 apply。重放补 observation 和来源 offers，
   唯一允许增加的是此前漏掉的商品级 wholesale offer；未知 SKU 集合变化仍拒绝。
4. 通过现有 `materializeDrafts` 流程刷新 Alibaba 拥有的草稿摘要与详情图来源，保护人工字段和发布状态。
   不要把“重放源记录成功”误报为“所有官网页面已更新”。
5. 抽查同一商品的 raw / observation / 草稿 Preview；需要公开更新的商品再显式审核并发布。
   已发布快照不随 raw 重放自动改变。未经过此步骤的线上记录仍可能显示此前的不完整投影。

## 线上发布与验收记录（2026-09-10）

追加真实样本检查：摘要刷新完成后，1,074 件均已存在、0 新建、0 失败。露营灯在真实列表 / Edit
显示 USD 7.67、MOQ 1；Preview 为 6 张主图、17 张详情图，最后一张在浏览器成功加载。
另一个纸篓草稿的来源报价确实不可用，但保存的 MOQ 为 1。其列表原本仍显示横线，暴露了
Admin 摘要兼容读取把 MOQ 错绑在“价格可用”条件上的遗漏。此处不是再次重新解析 raw：
共用 eligibility gate 下分开读取 MOQ 和价格，列表 / Edit 复用同一 helper；人工覆盖和失效
来源仍不得使用该 fallback。新增两项测试先红后绿，并增加对应浏览器边缘用例。
这项 UI 修复与询价持久化等待断言一起纳入 PR #44，必须以其最新提交的 CI/CD 与线上验收为准。

- PR [#43](https://github.com/vibelingan/channel/pull/43)：head `5f87abba` 的完整 CI 通过后，合入 test，merge SHA 为 `5678d0477b743654be508cd0d8543d27dbe3bf49`。
- [Deploy Test 34455803773](https://github.com/vibelingan/channel/actions/runs/34455803773) 成功：同 SHA 完整 CI、资源预检、函数包 cold-start、前端构建、部署冒烟、真实站点 41 项 public + 19 项 catalog 全通过。
- 独立 HTTP 读取确认 admin / public-api / alibaba-catalog-sync 均返回该 releaseId；网页由同一次工作流构建部署。本轮没有通过 MCP/本机 CLI 直接部署任何云函数。
- 部署前后公开商品基线为相同 9 个 ID。人工价格、网站分类及发布状态属于保护项，不随来源修复覆盖。
- 真实后台全量 validate：1,074 source products、54 页、3,672 variants、3,661 attributed variants、2,943 warnings；价格分布是报价记录计数，非商品计数：fixed 465 / tiered 1,808 / unavailable 1,870。
- 后台商品总数 1,081 与本轮范围不冲突：数据库只读确认 7 件没有 `alibabaPrimarySourceKey`。不把非 Alibaba 商品塞入本轮来源重放。
- 回填批次 `raw-replay-ea4291a4-5e23-4c03-a6b2-d5a1d2ec65d0`：2026-09-10 09:21:07 UTC 服务端确认为 `status=applied / nextApplyIndex=54 / totalSourceProducts=1074`。前台切换编辑页后，数据库 manifest 仍继续前进；此处以服务端记录为验收依据，不以页面提示替代持久化证明。
- 独立读库确认露营灯 observation 的更新时间为 09:21:05 UTC：47 条属性、6 张主图、17 张描述图、1 个有三个选项属性的 SKU，商品报价 USD 767 分 / MOQ 1，SKU 无效报价保留 MOQ 1。仍是已有 raw 的重算，不是当天新调用 Alibaba。
- [认证闭环验收 34456817806](https://github.com/vibelingan/channel/actions/runs/34456817806) **失败，不计为通过**：分类预览 0 待应用、两个既有公开样本各六张图且人工值不变、真实询价提交成功；最后读取仍为 in_progress，测试没有正确等待完成保存。此通道使用现有 CI/CD 的 acceptance-only 模式，不单独部署。
- 实际普通详情路由 `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f` 的人工覆盖确实是一档 `1000+ / USD 3.80`。公共响应同时保留旧 `moq=2` / `unitPrice=5.70`，不能把旧字段当作当前有效价格。页面手测 999 低于 MOQ、1000 返回 USD 3.80、1.5 非法；没有擅改客户人工阶梯。

### 认证验收等待修复（PR #44）

失败测试在整个 Process inquiry 区域寻找 `In progress` / `Completed`。下拉选项会提前出现，
说明文字本来就有 `Completed means ...`；因此它不能证明保存完成。仅靠末尾一次读库，
也会在上一笔保存/页面刷新尚未完成时提前失败并结束浏览器。此次实际测试记录停在版本 1。

修复复用 `expectInquirySaved`：等待刷新后的 `data-inquiry-version`、当前状态段落和已复位的
Save 按钮，再进行下一步。不依赖瞬时提示——编辑器按版本重新挂载，旧实例的提示会消失。
本地正式链路增加 700ms 的真实后端请求传输延迟，仍使用真实 handler/DB；完成后刷新页面，
再由 API 独立确认版本 3 / completed。修正后的 41 public + 19 catalog + 4 formal 全通过。

线上测试记录 `6f7907c8-0676-429d-8119-4ceabba5d849` 已通过正常后台操作完成，
09:16:29 UTC 只读数据库确认为 `status=completed / version=2 / notification=disabled`。
这是独立人工浏览器核验，不能冒充原失败自动化已通过；修正测试须按 [PR #44](https://github.com/vibelingan/channel/pull/44)
的 CI/CD 再执行。以上是截至 09:22 UTC 的可核验记录，后续 Actions 结果以对应运行页面为准。

本轮未重发邮件、改 DNS，也没有删除旧人工价格兼容字段。原始数据回填完成不等于未经审核的
描述图已公开；后台摘要刷新、同商品 Preview 和正式批准仍遵循前述交付顺序。

验收完成标准不是所有组件出现文字，而是：源字段有明确去向；无法采用时有明确原因；
同一商品版本、SKU、数量和价格策略在各入口得到相同业务结果；未审核内容仍不会泄露。

框架依据：[React 避免重复/冗余 state](https://react.dev/learn/choosing-the-state-structure)，
[TanStack Query 的按数据身份划分 query key](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)。
这些支持请求/状态组织原则，不代表需要为本次修复新增状态管理依赖。
