# 统一商品详情 UI：下一阶段最终范围

日期：2026-09-05

状态：分析与实施计划。本文覆盖上一份 CATEGORY-AND-NEW-UI-INTEGRATION 中的
执行顺序：**暂停分类映射和分类模型改造，先完成公共详情数据与新 UI 的本地闭环。**
本轮没有实施应用代码、创建分支、合并、提交、推送或部署。

## 1. 先把三个容易混淆的概念分开

| 概念 | 当前值或来源 | 结论 |
| --- | --- | --- |
| 网站产品大类 productFamily | headphones / ai-gadgets / toys / misc | 客户的网站导航，不是 Alibaba API 定义 |
| 旧耳机子类 category | wired / office / bluetooth | 网站历史字段，只适用于耳机，不是 Alibaba 类目 |
| 来源类目 | Alibaba category_id，可能还有名称或路径 | 供应商分类体系；需要业务映射才进入网站分类 |

358 个没有网站 family 的商品不意味着过时或同步失败。此前数据确实来自已完成的
Alibaba 同步，问题是尚未确认它们如何对应客户网站的导航。不是每个来源类目都有
一一对应的网站类目，也不应该为了让菜单有数字就随意归类。

分类暂停期间：保留已有字段和映射；不把其余商品批量归入 misc、AI 或 Toys；不新增
公开类目；不补猜测子类；不重新抓取全量商品。用已经确认的耳机样本验证 UI。UI 的
categoryLabel 是可选显示信息，不应成为打开详情的条件。

客户后续需确认：网站四个大类的业务边界、其他商品是扩充导航还是不展示、连接方式
与用途应作为子类还是可叠加筛选属性。这是待办，不阻塞本阶段。

## 2. 分支与原型：已核实的具体证据

- 当前基础：`fix/alibaba-sync-storage-wiring@97c645a`。
- 合并提交 `2fe36a4` 的两个 parent 是 `d77b546` 和 `0cf5526`。因此 Excel 稳定分支
  **截至 0cf5526 的全部提交历史**已合入 wiring，而非只挑选了几个文件。
- 当前 HEAD 相对本地记录的 `origin/feat/dianxiaomi-excel-import@0cf5526` 为 54/0。
  这不是对尚未 fetch 的未来远端提交的承诺，也不表示合并后每个文件都保持原样。
- Excel 本地 worktree 在 `396981f`，相对该稳定分支落后 15 个提交，仍有应用修改和
  untracked prototype。**未提交内容不属于任何 Git merge 的提交历史。**
- 新 UI 在 `$PROJECTS_DIR/channel-dianxiaomi-excel-import/` 工作区，不在当前
  `$CHANNEL_REPO/` 工作区。

原型目录：`docs/dianxiaomi-excel-import/product-detail-rfq-prototype/`。
`index.html` 加载 `src/main.jsx`，后者加载 `App.jsx` 和 `styles.css`。这是 Vite/React
原型，构建后仍由一个 HTML 页面加载 JS/CSS；HTML 与 JSX 不是两套 UI。

运行进程证据：本机 4174 HTTP 服务的 directory 正是此目录的 `dist/client`；
Cloudflare tunnel 指向 `http://127.0.0.1:4174`。该本地地址返回同标题的 HTML。
本轮在浏览器实际打开并截图：Xiaomi 14，大图和父商品缩略图、Black/White/Blue/Powder
选项、12GB+256GB、规格 disclosure、询价与定制两个入口、缺失数据模拟控件。
这确认的是目前保留并曾用于 tunnel 的原型，不凭文件后缀推断最早的制作过程。

原型仍含硬编码样本及 demo 状态，不直接作为生产应用复制上线。保留原型工作区不动，
在当前分支实现组件化版本。原型页头不覆盖实际网站的全局 header/nav。

## 3. Adapter 已经统一到哪里，尚未统一到哪里

### 已有，不重做

`packages/catalog-import/src/source-observations.ts` 定义公共 runtime schema、
`CatalogSourceObservation` 和 `CatalogObservationAdapter<Input>`。

- Excel：`providers/dianxiaomi/observations.ts` 的 `dianxiaomiObservationAdapter`。
  在 admin 的 `catalog-import-store.ts` 调用并保存公共 observations。
- Alibaba：`packages/alibaba-catalog-sync/src/alibaba-observation-adapter.ts` 的
  `alibabaObservationAdapter`。在 sync 的 `ingest.ts` 调用并保存公共 observations。
- 两者使用同一个严格验证器和 schema version。输入不同，输出契约相同；Excel
  detect/parse 文件适配器继续保留，Alibaba 不需要假装解析一个 Excel 文件。

共同字段包括 identity/category、文本描述、媒体、变体 options、inventory 的语义、
不同种类 offers、证据和 warnings。店小秘可能按店铺产生多个 observation，不能把
“一个 observation”机械当成“一个新的公共商品”。既有来源绑定和库存协调必须保留。

本轮重新执行针对性测试：Dianxiaomi observation + 共用 schema 8/8；Alibaba adapter
3/3。证明当前代码契约成立，不把它当作新 UI 浏览器验收。

### 缺口，必须进入本阶段

1. 店小秘 publish service 已通过 bindVariant/writeVariant 写 `productVariants`；
   Alibaba linking/promotion 尚未执行相同的公共变体物化，仅有来源变体和审核摘要。
2. 当前 public-api 详情读 `productVariants`，所以仅替换 UI 不会自动获得 Alibaba SKU。
3. 当前分支的列表接口仍附带 variants，且每产品截到 50；之前计划中的“仅详情加载
   variants”是目标，不能描述成现状。新 UI 不依赖这个截断列表来做选型。
4. 原型规格是手机样本硬编码；通用 observation 当前并没有完整的公开 highlights/
   specificationGroups 契约。没有证据的规格组应隐藏，不能让耳机继承手机卖点。

因此，“已有统一 adapter”不等于“已有统一、可直接给 UI 使用的详情”。下一阶段补齐
中间的公共详情转换，不再让组件判断 provider 并读取不同源 JSON。

## 4. 实施分支与架构决策

继续使用当前 wiring 分支，保留上轮离线审计的未提交文件，分别形成清晰可审查的改动。
不再重复合并稳定 Excel 分支，不修改 Excel 原型工作区，不整包引入它的未提交改动。

Catalog refactor 本地远端引用为 `03b5f17`，其已实现的 schema、media、pricing、
presentation 边界可复用；但当前 wiring 分支还没有 `apps/site/src/catalog` 目录。
不能把“从现有目录改一下”作为错误前提，也不等待整个活跃 refactor 完成。

实施第一步选择性移植已验证的必要 contract/media/presentation 模块及其测试和依赖，
按原目录与职责延续，记录来源 SHA；不 wholesale merge 活跃 refactor。优先检查其
strict public schema 与当前 import variants/Alibaba 字段的差异，统一再接消费者。
不另建平行的 public DTO、第二套 Gallery 或 provider-specific React 页。

新 UI 的目标链路：

```text
Excel adapter ───┐
                ├─ common observations + explicit source bindings
Alibaba adapter ┘
   → canonical product/variant/content projection
   → shared validated detail contract
   → gallery / option selection / pricing / specs / quote state
```

本阶段转换与写入只针对隔离的本地样本数据库。公共 schema/mapper 为后续真实接入保留
同一实现；本地路由委托真实 handler，不复制一份返回 mock JSON 的“模拟后端”。

## 5. 五个可独立验收的小阶段

### UI-01：固定原型、样本及公共详情契约

工作：登记原型来源，提取去敏后的真实 Alibaba 耳机 observation；选一条多 SKU/阶梯价
样本、一条缺价格样本。缺失图片/描述等另做明确标记的派生测试，不冒充真实返回。
同时保留一个店小秘样本作交叉验证。

样本在私有、gitignored 本地数据目录保存，记录 capture time 和 digest；已去敏且获准
入库的最小 fixture 才可提交。前端不接触 token、账户标识、raw 存储地址或完整 evidence。
云端不可读时可用现有合成 fixture 开发，但真实 Alibaba acceptance 明确保留未通过。

共享详情包含：canonical product ID/name、可选分类 label、图片引用、variants 的
canonical ID/可选 SKU/options、按变体关联的报价状态、库存状态、文本/有依据规格。
沿用金额 minor units 与 fixed/tiered/range/unavailable/negotiable 分支，不用统一 number。
真实 supplier stock 不能未经定义变成“我们的库存”；未知必须与 0 不同。

验收：两个 adapter 输出都能经过同一个 mapper/decoder；异常/null/空字符串/重复标识/
不合法价格被明确拒绝或显示缺失状态；页面不需要 provider 分支；私有字段不进入公开契约。

### UI-02：打通本地 canonical variants 与详情接口

工作：复用已存在的 product/source/variant 绑定机制，把 Alibaba source variants 接入
canonical variants。SKU 是显示/匹配证据，不单独作为全局主键；缺 SKU 不丢变体，名称
相似或相同 SKU 不跨 provider 自动合并产品。店铺 observations 继续先协调再形成商品。

重复执行不新增第二份变体；源变体移除只影响自己的绑定，不误删其他来源或人工变体。
人工编辑、review、新产品标记、published 状态不因本地 mapper 改动而被重置。

按单产品 ID 查询详情，稳定排序用 position + ID。变体超过单次上限时采用显式分页/
hasMore，不静默截断后仍显示“全部选项”。列表摘要新契约不加载所有变体；旧列表消费者
先审计兼容，不在本轮直接删旧字段造成回归。

媒体使用既有本地存储/鉴权 handler；本地允许发布的克隆样本走现有公开 gate，真实
云端草稿不发布。不扩大公开 API 读取未发布商品的权限。

验收：真实 handler 返回两种来源相同详情结构；重复物化幂等；未知 ID、无变体、超过
50 变体、移除变体、私有字段和媒体访问边界的测试通过。

### UI-03：落地新详情视觉结构

工作：在现有网站 shell 中实现左侧主图/缩略图、右侧商品信息/变体选项/数量报价、
规格 disclosure、移动端 sticky CTA。复用既有字体/颜色/tokens 与原型的布局关系。
不重新设计 Admin 全局导航或整个商品列表；列表只做打开/返回新详情所需的最小接线。

替换 Xiaomi、Color/Storage、库存和 specs 的硬编码。选项名称由真实数据给出；没有
显式 variant-image 关联时，选择颜色不能猜测第 N 张图就是该变体。空图片不塌版，
描述始终文本或允许的结构化块，不直接渲染源 HTML。无依据的 highlights 不出现。

验收：1440×1024、390×844 与中间宽度长文本不溢出；两种来源渲染同一组件；没有
“缺字段所以展示手机默认值”；选型、图库、报价窗口各自符合数据语义。

### UI-04：交互状态与 RFQ 本地边界

详情状态与列表状态分开：product/request generation 防止旧请求覆盖新商品；返回保留
列表页码/筛选并恢复焦点；切换产品重新验证选中变体；失效 URL variant 不静默落到错误 SKU。

选择仅允许真实存在的 variant 组合；数量有上下限/MOQ 状态，阶梯边界、空档和缺价格
都有明确显示。RFQ 中的商品、变体、数量跟随当前有效选择，不引用已切换产品的旧状态。

保留询价与定制分流。使用已有 React/TypeScript、原生 dialog/form 或现有表单基础，
不为本阶段增加新状态库。补齐 focus trap、Escape、关闭后焦点恢复、后台内容不可交互。

本阶段只验收本地 RFQ 填写/校验/复核，不发送邮件、不创建云端询价、不显示伪造成功
编号。最终发送在 preview 中明确不可用。真正的 durable RFQ API 作为后续独立工作。

### UI-05：本地证据与交付

验收至少覆盖：

- 多 SKU/阶梯价耳机；无报价耳机；店小秘样本；明确标记的缺失字段派生场景。
- 切换变体、图库不误改 SKU、数量跨阶梯、返回列表、直接打开详情、快速切换请求。
- dialog 键盘操作、表单错误、关闭重开、无真实外发或假成功。
- 原有列表、Admin NEW/审核状态、未发布图片 gate 和公共 payload 隐私回归。
- 类型检查、相关单测/集成测试、桌面与移动浏览器截图、console errors 检查。

给用户的是一个已启动的 localhost 预览和逐项验收结果。无需重新 OAuth，也不依赖
Cloudflare tunnel 存活。需要外部分享或 test 部署时另行按发布流程处理。

## 6. 明确排除与后续工作

- 网站分类映射、358 件商品归类、通用分类树/新的菜单：等客户确认。
- 云端批量变体迁移、全量 replay、同步调度变更：本阶段不执行。
- 新 Excel 云端上传/worker/队列/重试：不因 UI 接入而开启。
- 正式 RFQ 持久化、邮件、CRM 或订单：后续独立验收。
- VIP 定价、汇率或供应商价转销售价的新业务政策：不在范围；保留已有规则与报价性质。
- 泛化 HTML 智能抽取、同义属性大规模清洗：不阻塞 UI，先保守展示已有事实。
- 重做 Admin 管理台、新的通知系统、其他来源接入、完整 refactor 合并：不做。

## 7. 本轮完成与下一步开始点

本轮完成：Git ancestry 核验、tunnel→本地目录→HTML/JS 原型来源核验、实际原型截图、
两种 adapter 调用点及共同 schema 核验、11 项针对性测试通过、上述范围收敛。

历史开始点为 **UI-01 + 最小公共 schema 依赖接入**，然后 UI-02，再接原型视觉与状态。
分类不是前置依赖。不要跳过 canonical variants，直接把原始 Alibaba JSON 灌进原型。

## 8. 2026-09-06 执行入口更新

UI-01 已在 `4cd6344`、UI-02 本地 canonical/API 演练已在 `60b051b` 完成各自记录的范围；
不是云端新详情已接入真实 sync。原 UI-03..05 现在细分成 8 个顺序 CUI MIU。

店小秘视觉原型和分析工作区的详细 HLD/LLD/27 个 DXUI 任务已作为来源快照搬入当前工作区。
下一步以 [shared-product-ui 入口](../shared-product-ui/README.md) 和其修订设计为准，
不要重新执行本文件的历史 UI-01 开始点。当前只完成设计整合，UI 实现尚未开始。

范围保持本地优先；正式云端同步接线、分类、Excel worker、RFQ 外发仍是后续阶段。
