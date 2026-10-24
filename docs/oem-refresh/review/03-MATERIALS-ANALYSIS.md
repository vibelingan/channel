# Doc 3 — 客户资料通读与内容更新分析 / Materials Read-through & Content Plan

> **来源:** `/Users/SeanCai/Documents/OEM网页资料`（客户新上传）
> **一句话总结 (TL;DR):** 客户资料里已经**备齐了三大板块的全部文字内容**（2 个公司案例 + 3 篇市场拆解 + 3 个蓝海概念），branch 作者显然读过这批资料（首页的产品名/价格/统计数字都对得上），但**只搭了页面壳、没把内容录进去**，导致三页 500。你要的「内容录入」= 把这批资料填进缺失的 3 个 `data/*.ts` 文件。另外，客户的**首页 PPTX 方案是传统 OEM 版**，跟 branch 做的「AI 满屏」首页方向不一致 —— 你说「AI 不算」，那首页应以 PPTX 为准。

> **提取出来的纯文本**都放在 `channel-oem-review/extracted/`（00-SPEC / 01-cases / 02-teardown / 03-blueocean / 04-homepage-plan），可直接复用。

---

## Part 0 — 明确排除项（你说的「AI 不算、3D 不算」）

规格书（PRD）里下面这些是**本期不做**的，先划清边界：

| 规格书板块 | 内容 | 为什么排除 |
|---|---|---|
| §4.5 AI 智能估价器 (AI Instant Estimator) | 多步骤表单 + 矩阵公式算价 + 邮件抓取 | AI 功能 |
| §4.1 AI 核心赋能展示区 (How AI Drives Us) | 4 张 AI 能力卡（Trend/Cost/Supplier/Logistics）| AI 功能/内容 |
| §3 悬浮 AI 客服 | 24h 自动回复机器人 | AI 功能 |
| §4.4 / §7 3D 互动检视器 | `.gltf/.glb` 上传、360° 旋转、AR 投影 | 3D 建模 |
| §4.6 客户专属中心 + Milestone Tracker | 登录后台、合约/BOM/QC 文档中心、3D 进度条 | 规格书本身标注「预留扩充」，非本期 |
| §4.3 Newsletter (Mailchimp/HubSpot) | 订阅框 + 邮件营销名单 | 需外部 API 集成，建议延后（见 Part 5） |

> ⚠️ **重要区分:** 蓝海产品叫「SomniFlow **AI** Sleep Pods」等，但这只是**产品名称/展示内容**，不是要你实现 AI 功能 —— 属于「纯展示，内容录入」，做。同理，拆解报告里提到「Edge AI 芯片」也只是产品分析文字，照录。

---

## Part 1 — 规格书全貌（仅供理解，非本期全做）

`Diversity_Technology_Website_Upgrade_Specification.pdf`（10 页 PRD，繁中）规划的是一个 5 页平台：

| # | 页面 | 本期是否做 |
|---|---|---|
| 1 | 主页 (Home) | ✅ 做（按 PPTX 传统 OEM 版，见 Part 2.1）|
| 2 | 公司案例 (Success Stories) | ✅ 做（内容录入）|
| 3 | 市场案例拆解 (Teardown Lab) | ✅ 做（内容录入，修 500）|
| 4 | 蓝海产品 (Blue Ocean) | ✅ 做（纯展示，修 500）|
| 5 | AI 智能估价器 | ❌ 不做（AI）|
| — | 客户专属中心 / 登录后台 | ❌ 本期不做（预留）|

设计规范（§5，可采纳）：深空蓝/钛金黑主色 `#0f172a`/`#1e293b`，科技青 accent `#0284c7`/`#38bdf8`，白底 + 浅灰分区，Inter 字体。响应式，PC PageSpeed ≥90 / 移动 ≥80，全站 HTTPS，GDPR Cookie 横幅。

---

## Part 2 — 四大板块：资料 → 落点 → 缺口 → 动作

### 2.1 首页重构 (Homepage)

**⭐ 关键决策点:** 现在有两套互相冲突的首页方案：

| | branch 现状 (`oem-phase1`) | 客户 PPTX《OEM官网首页优化方案》|
|---|---|---|
| Hero | "Empowering Global Brands via **AI-Driven** & Agile Supply Chain" | "One-stop OEM manufacturing, from idea to shipment" |
| 第 2 屏 | **AI 能力展示**（4 张 AI 卡）| **What We Do** — 4 大核心服务 |
| 主线 | AI 叙事 | OEM Process 流程可视化 → 工厂&团队实力 → Why Choose Us → 认证&客户 → CTA |

客户 PPTX 的首页结构（9 屏）：
1. **Hero** — "One-stop OEM manufacturing, from idea to shipment" / `OEM/ODM DEVELOPMENT | Factory Direct | Global Delivery` / CTA：`Start Your Project` `See Our Factory`
2. **What We Do** — OEM Product Development / Mold & Manufacturing / Quality & Compliance / Global Delivery
3. **OEM Development Process** — Sketches → Appearance Design → Mechanical Design → Circuit Design → Prototyping → Mold Building → Mold Test Shot → PCBA Mass Prod → Pilot Run → QC
4. **Factory & Team Strength** — 工厂视频 + 工厂照片滚动
5. **Product Capability** — 产品能力
6. **Why Choose Us** — 团队滚动合照 + 优势
7. **Certifications & Global Clients** — 认证 + 客户 logo
8. **CTA** — "Ready to develop your next product? Send us your idea, drawing, or sample — our team will provide an OEM solution within 24 hours."

> **建议（因为你说「AI 不算」）:** 首页以 PPTX 为准。保留已建的 `ServiceGridSection`（≈What We Do）、`FactorySection`、`CTASection`、以及 `TeardownTeaser`/`BlueOceanTeaser`（这俩是内容导流，不是 AI 功能，保留）；**下架 `AIShowcase`（4 张 AI 卡）与 AI hero 文案**，换成 PPTX 的 hero + 补上 **OEM Process 流程时间线**（仓库已有 `ProcessTimeline.astro`/`WorkflowChain.astro` 可复用）+ **Certifications & Global Clients** 区。
> **动作:** ①改 hero 文案/CTA ②`AIShowcase` 撤下或改为「Why Choose Us」③加 OEM Process 区 ④加 Certifications & Clients 区 ⑤接入替换视频（见 Part 3）⑥换 logo。

### 2.2 公司案例 (Success Stories) — 修 500 + 内容录入

**资料提供了什么** (`01-cases.txt`，来自 `历史客制化案例/文案介绍.docx`)：**2 个完整案例**
| 案例 | 标题 | Capabilities |
|---|---|---|
| 案例一 | Children's Sleep Training Clock（儿童睡眠训练时钟，for a leading children's brand）| Product Design · Engineering · Tooling · Manufacturing · Packaging |
| 案例二 | Disc Repair System（专利手动光盘修复机构）| Precision Engineering · Mold · Assembly · QC · OEM |

- **客户 logo**（`合作客户/`）：Artcoustic、pabobo、AS、CoreMee、DI、Audio Diversity、教育机构等（规格书点名 Allsop 美国 / Claessens' Kids 瑞士 / Landport 日本，非公开客户用代称如 "Leading UK Audio Brand"）。
- **认证 + 产品图**（`证书/`）：CE / FCC / EMC / JD 认证；游戏耳机 OP1、耳机 SC3、音响 CS1/AS1 产品照。

**落点:** `apps/site/src/data/successStories.ts`（**缺失，需新建**）+ `/success-stories` 页。字段参照 `collections.ts` 的 `successStories`（title/client/category/summary/**situation/task/action/result** STAR/capabilities/metrics/imageIds）。
**缺口:** 现有文案只有 S 概述，**STAR 四段 + Metrics（成本降低 15%、打样缩短 30%、准交 99.8% 等）需要跟客户补齐**（规格书 §4.2 要求高亮 Metrics）。
**动作:** 新建 data 文件录入 2 案例；客户 logo 墙 + 认证墙；STAR/Metrics 待客户补充（Part 5 Q）。

### 2.3 市场案例拆解 (Teardown Lab) — 修 500 + 内容录入

**资料提供了什么** (`02-teardown.txt`，来自 `HardwareTeardownAndCostAnalysis_WithImages.docx`)：**3 篇完整报告**，每篇含 产品概述 / 市场分析 / 硬件拆解 / **BOM 成本表** / 量产风险 4 大块：

| 报告 | 品类 (category) | 零售价 | 出厂价 | 毛利率 | MOQ |
|---|---|---|---|---|---|
| Oladance OWS Pro 开放式耳机 | Audio & Acoustics | $199 | $43 | 78.39% | 10,000 |
| ClicBot 模块化机器人 | STEM & Robotics | $449 | $140 | 68.81% | 10,000 |
| Lofree Flow 2 矮轴机械键盘 | 3C Peripherals | $159 | $73.50 | 53.77% | 10,000 |

**落点:** `apps/site/src/data/teardownReports.ts`（**缺失，需新建**）→ 修好 `/teardown-lab` + `/teardown-lab/[slug]`。字段完全对得上 `collections.ts` 的 `teardownReports`（title/slug/product/category/retailPrice/estBomCost/estMargin/moq/summary/overview/marketAnalysis/hardwareTeardown/**bomBreakdown(json)**/riskAnalysis）。
**内容充足度:** ✅ 非常充分，可直接录入。BOM 表转成 `bomBreakdown` JSON 数组。
**动作:** 新建 data 文件，把 3 篇报告录入（含 BOM 表）。**注意:** 首页硬编码「78% Avg. Margin」不准（真实均值 ≈67%），录入后页面会动态算出 67%，需同步改首页 teaser 数字。

### 2.4 蓝海产品 (Blue Ocean) — 修 500 + 内容录入（纯展示）

**资料提供了什么** (`03-blueocean.txt`，来自 `BlueOceanODMProductConcepts_WithImages.docx`)：**3 个完整概念**，与 branch 首页硬编码的名字/价格**完全一致**（证明作者读过此文档）：

| 概念 | category | MSRP | Ex-work | MOQ | 合作模式 |
|---|---|---|---|---|---|
| SomniFlow AI Sleep Pods | Wearables/Health | $199 | $48.50 | 2,000 | White-label / Exclusive Buyout / Co-Dev |
| LumiCogni Desktop AI Hologram | Education | $289 | $115 | 3,000 | 同上 |
| AeroSense AI Sports Headband | Sports & Outdoor | $229 | $65 | 2,000 | 同上 |

每个概念含：产品概念、目标受众/市场缺口、核心技术规格表、商业矩阵/定价、**三档 B2B 合作提案（partnershipTiers）**。
**落点:** `apps/site/src/data/blueOceanProducts.ts`（**缺失，需新建**）→ 修好 `/blue-ocean` + `/blue-ocean/[slug]`。字段对得上 `collections.ts` 的 `blueOceanProducts`（name/slug/tagline/category/msrp/estBomCost/moq/summary/marketGap/techSpecs(json)/bomBreakdown(json)/**partnershipTiers(json)**）。
**内容充足度:** ✅ 充分。**排除 3D viewer**（§4.4 要的 .glb/360°/AR 不做），详情页用静态图代替。
**动作:** 新建 data 文件录入 3 概念（含技术规格表、合作三档）。

---

## Part 3 — 素材资产清单与处理 / Asset Inventory

| 资料 | 用途 | 处理动作 |
|---|---|---|
| `1.主页/公司logo.pdf` | 站点 logo（客户真 logo，非当前 "CHANNEL" 占位）| PDF→SVG/PNG，替换 `logo-channel.svg` |
| `1.主页/工厂照片/*`（10+ 张）| Factory & Team 区 | 压缩转 webp |
| `替换视频/Video Project 2.mp4`（**171MB**）| 首页/工厂 hero 视频 | ⚠️**必须压缩**（171MB 不能直接上 web，目标 <10MB / 或走流媒体）|
| `1.主页/服务流程图介绍素材/*` | OEM Process 流程区 | 压缩转 webp |
| `1.主页/销售团队照片/*` | Why Choose Us 团队合照 | 压缩转 webp |
| `2.客户案例/合作客户/*` | 客户 logo 墙 | 抠白底、统一尺寸 |
| `2.客户案例/证书/*` | 认证墙 + 产品图 | 压缩转 webp |
| `3.市场拆解/*.docx` 内嵌图 | 拆解报告配图 | 从 docx `word/media/` 解出（**注意第三方产品图版权**，见 Part 5）|
| `4.蓝海/*.docx` 内嵌图 | 概念产品渲染图/芯片图 | 同上 |

> `Company Introduction.pptx` 是**纯图片版**（几乎无文字），做视觉参考用，不用录文字。

---

## Part 4 — 建议实施顺序 / Recommended Build Order

1. **🔴 解阻塞（先）** — 新建 3 个 `data/*.ts`（teardown/blueOcean 内容已齐可立即录；successStories 先录 2 案例骨架）。**一旦补齐，3 页 500 全好、`astro build` 通过 → 「基础功能可用」达成。**
2. **🟠 修 UI bug** — `BlueOceanTeaser.astro` 标题加 `pr-*` 消除价格徽章重叠（几行 CSS）。
3. **首页重构** — 按 PPTX：换 hero、撤 AIShowcase、加 OEM Process、加 Certifications & Clients、接视频、换 logo。
4. **公司案例完善** — 客户 logo 墙 + 认证墙 + STAR/Metrics（待客户补内容）。
5. **素材处理** — 压视频、转 webp、解 docx 内嵌图、转 logo。
6. **同步修正** — 首页「78%」改为真实均值；`en-US.md` 里 "Sign In→/admin" 与实际 /login 统一。

---

## Part 5 — 需要你/客户拍板的问题 / Open Decisions

1. **首页方向:** 确认按客户 PPTX 传统 OEM 版走、下架 AI 展示区？（我判断你说「AI 不算」= 是。）
2. **前台数据源:** 本期用静态 `data/*.ts`（快、契合「纯展示/内容录入」）还是接后台 CMS 集合？（建议先静态，后台留作二期。）
3. **拆解报告 IP 风险 ⚠️:** 3 篇报告点名真实竞品（Oladance/ClicBot/Lofree）并附第三方产品图 + 详细 BOM 逆向。公开发布可能有版权/法务风险 —— 确认客户是否接受，或需匿名化/换自制渲染图？（业务决策，先标出。）
4. **公司案例内容:** STAR 四段 + Metrics 数字需客户补齐，现有文案只有概述。
5. **替换视频:** 171MB 需压缩，确认这就是首页要用的视频？
6. **Newsletter:** 规格书列为「关键功能」但需 Mailchimp/HubSpot —— 本期跳过还是要做？

---

**下一步:** 等你对 Part 5（尤其 Q1/Q2）拍板后，我就按 Part 4 顺序动手 —— **第 1、2 步（补 3 个 data 文件 + 修 CSS）不依赖任何决策，可以立即开工**，先把网站从「三页 500」救成「基础可用」。要我现在就开始第 1、2 步吗？
