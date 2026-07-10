# Doc 4 — 实施交接文档 / Implementation Handoff (for the coding agent)

> **给实施 Agent 的说明:** 本文档是 review + 客户资料通读后整理的**可执行任务清单**，分成
> **Part A｜业务逻辑（内容/设计，照客户资料改）** 和 **Part B｜技术（代码 review 发现）**。
> 优先级：**Part B 的 B0/B1（构建阻塞 & 未修的 bug）→ Part A 首页重构 → 其余**。
>
> **真理来源 / Source of truth（用户已明确）:**
> - **PPTX `OEM官网首页优化方案.pptx` = 本轮优化的唯一依据**，9 页每页 = 一个优化点。
> - **PDF PRD = 长期 roadmap**（AI 估价器 / AI 客服 / 3D 建模等都是**未来**，本轮不做）。
> - **其它文件夹 = 网站要用的素材**，目标是**每一份素材都有落点**（见 A2 映射表）。
> - 幻灯片已导出为图片，可直接看：`channel-oem-review/extracted/pptx-media/`（imageNN.png），
>   关键页对应关系见每节标注。

---

## 现状快照 / Current State

- 分支 `dev/albertli/oem-phase1` @ `275b0b3`。前一个 Agent 已提交
  `fix: add missing data files + fix .gitignore (P0)` —— **构建已 green**（`astro build` 20 页全过，
  3 个原本 500 的板块页 + 详情页都能生成）。✅
- **但首页方向错了**：现在首页走的是 **AI 叙事**（`AIHero` + `AIShowcase`），
  那是 **PDF roadmap** 的东西；**本轮应照 PPTX 做传统 OEM 首页**。
- Bug #2（蓝海卡片价格徽章压标题）**仍未修**。

---

# PART A ｜ BUSINESS LOGIC（照客户资料改）

## A1. 首页重构 —— 严格照 PPTX 9 页重排（每页 = 一个优化点）

**核心动作：把首页从「AI 叙事」改成「PPTX 的传统 OEM 叙事」。**
下表逐页给出优化点、对应素材、以及与现状的差异。

| PPTX 页 | 板块 | 内容要点（照 PPTX） | 用什么素材 | 现状差异 / 动作 |
|---|---|---|---|---|
| P2 | **Hero** | 标语 `One-stop OEM manufacturing, from idea to shipment`；副标 `OEM/ODM DEVELOPMENT \| Factory Direct \| Global Delivery`；正文 "Product design, engineering, tooling, production, quality control, and global delivery — all managed by one accountable team."；CTA：`Start Your Project` + `See Our Factory` | —（可选工厂视频背景）| ❌ 现在是 `AIHero`「AI-Driven & Agile Supply Chain」。**改文案为 OEM 版**，CTA 指向 `/oem` 与工厂区锚点 |
| P3 | **What We Do**（4 服务）| OEM Product Development / Mold & Manufacturing / Quality & Compliance / Global Delivery | 图标 | ✅ 已有 `ServiceGridSection`，文案基本符合，**保留**（措辞对齐 PPTX 即可） |
| P4 | **OEM Development Process**（10 步流程）| Sketches → Appearance Design → Mechanical Design → Circuit Design → Prototyping → Mold Building → PCBA Mass Prod → Mold Test Shot → Pilot Run → QC | `1.主页/服务流程图介绍素材/*`（对应流程照片；见 `pptx-media/image31.png`）| 🔴 **缺失**。复用已存在的 `ProcessTimeline.astro` / `WorkflowChain.astro` 组件，新建此区 |
| P5 | **Factory & Team Strength** | 统计：**20+ Years Experience / 40+ Engineers / 5000+ m² Facility / 40+ Countries**（见 `pptx-media/image32.png`）＋ **工厂视频 + 工厂照片滚动** | 视频 `替换视频/Video Project 2.mp4`；照片 `1.主页/工厂照片/*` | 🟠 现有 `FactorySection` 统计数字**错**（现为 2004/20+/50+/100%）。**改成 20+/40+/5000+/40+**，并加视频（复用 `HeroVideo.astro`）+ 照片滚动 |
| P6 | **Product Capability**（6 大品类，"保留"）| Plastic Products / Electronics / Headphones / Consumer Goods / Hardware Products / Promotional Products（见 `pptx-media/image33.png`）| 图标（可选产品图）| 🔴 **缺失**。新建 6 卡网格区（品类与 `collections.ts` 的 oemProjects.category 完全一致）|
| P7 | **Why Choose Us** | **左**：团队滚动合照（**替换掉被红叉划掉的 "15+ Years"/"100+ Supply Chain Partners" 两张 stat 卡**）；**右**：保留 3 行 —— Flexible MOQ / Global Compliance Support / Dedicated Project Manager（见 `pptx-media/image34.png`，红叉是客户批注）| 团队照 `1.主页/销售团队照片/*` | 🔴 **缺失**。新建此区。注意客户红叉 = 删掉左边两张假数字卡，换成团队照片 |
| P8 | **Certifications & Global Clients** | 两组：① **Company & compliance**：CE / EMC / FCC / JD ② **Product test reports**：外观设计专利证书×N（见 `pptx-media/image36.png`）＋ **Global Clients** logo 墙 | 证书 `2.客户案例介绍/证书/*`；客户 logo `2.客户案例介绍/合作客户/*` | 🔴 **缺失**。新建认证墙 + 客户 logo 墙 |
| P9 | **CTA** | "Ready to develop your next product? Send us your idea, drawing, or sample — our team will provide an OEM solution within 24 hours." → OEM 询盘表单 | —（复用现有 `ProjectForm` / `/oem`）| ✅ 已有 `CTASection`，**保留**，确认 CTA 指向 OEM 表单 |

**下架（本轮）:** `AIShowcase`（4 张 AI 能力卡）= PDF roadmap 内容，从首页移除。
**决策点:** `TeardownTeaser` / `BlueOceanTeaser` 不在 PPTX 首页里（属 roadmap 提前露出）。
建议**移到首页靠下或移除**，让首页回归 PPTX 结构；Teardown Lab / Blue Ocean 仍作为独立导航页保留。→ **请用户确认**。

> ⚠️ **数字一致性**：公司 2004 年成立 = **20+ 年**。PPTX P7 把 "15+ Years" 用红叉划掉正因为它是**错的**。
> 全站统一用 **20+ Years / Founded 2004**，别再出现 15+。

## A2. 素材落点映射表（目标：每份素材都有家）

| 素材文件夹 | 落点 |
|---|---|
| `1.主页/公司logo.pdf` | 站点 logo（转 SVG/PNG，替换占位 `logo-channel.svg`）。注：证书上公司名为 **Channel Technology Limited** |
| `1.主页/工厂照片/*` | 首页 P5 Factory & Team 照片滚动 |
| `替换视频/Video Project 2.mp4`（＝`工厂照片/替换视频/…`，重复文件）| 首页 P5 工厂视频（**必须压缩**，见 B7）|
| `1.主页/服务流程图介绍素材/*` | 首页 P4 OEM Development Process 10 步配图 |
| `1.主页/销售团队照片/*` | 首页 P7 Why Choose Us 左侧团队滚动合照 |
| `1.主页/Company Introduction.pptx` | 参考素材（公司背景），无需录文字（纯图 deck）|
| `2.客户案例介绍/历史客制化案例/*.jpg` | Success Stories 两个案例配图（睡眠时钟 = veilleuse 图；光盘修复 = 51WIz…图）|
| `2.客户案例介绍/合作客户/*` | 首页 P8 Global Clients logo 墙 + Success Stories 客户 logo（**当前只有文字，未接图，见 A3**）|
| `2.客户案例介绍/证书/CE·EMC·FCC·JD` | 首页 P8 + Success Stories 认证墙 |
| `2.客户案例介绍/证书/AS1·OP1·SC3·CS1 产品图` | **产品图**（非认证！见 A3），用于 Product test reports 或产品展示 |
| `3.市场案例拆解/*.docx` 内嵌图 | Teardown Lab 报告配图（从 docx `word/media/` 解出）|
| `4.头脑风暴蓝海产品/*.docx` 内嵌图 | Blue Ocean 概念图（同上；**不做 3D viewer**，用静态图）|

## A3. Success Stories 内容需纠正（前 Agent 有理解偏差）

`apps/site/src/data/successStories.ts` 内容录入方向对，但**有几处「无中生有」**，在对外 B2B 可信度页面上是风险：

1. 🟠 **客户去匿名化**：源文案是 "a leading children's brand"（**刻意匿名**），Agent 擅自写成
   `Leading Children's Brand (pabobo)`。**除非客户确认可具名，否则改回匿名代称**。
2. 🟠 **指标是编的**：源文案**没有任何 metrics**，Agent 填了 "99.5%+ pass rate"、"CE/FCC certified" 等。
   这些会以「事实」展示。**改为占位/待客户提供真实数据**（规格书 §4.2 要的 15%/30%/99.8% 是**举例**，非本案真实值）。
3. 🟠 **STAR 的 Result 是编的**："sold through major retail channels" 等属推测。**标注为待确认**。
4. 🟡 **4 个"认证"其实是产品图**：`AS1/OP1/SC3/CS1` 是 `证书/` 里的**产品照片**，被当成认证名。
   真实认证只有 **CE/EMC/FCC/JD**（＋专利报告）。**拆开**：合规认证 vs 产品/专利。
5. 🟡 **客户 logo 未接图**：`clientLogos` 只有 `name`、没 `logo` 路径 → 现在渲染成文字。
   把 `合作客户/*` 图片拷进 `public/media/` 并回填 `logo` 字段。

## A4. Teardown Lab & Blue Ocean（内容基本 OK，注意两点）

- ✅ 三篇拆解 + 三个蓝海概念的**头部数字都准**（零售价/出厂价/毛利率/MOQ 与资料一致，BOM 表求和也对）。
- 🟡 **BOM 明细行是重推的**：ClicBot/Lofree 的分项被按模块重新拆过（求和对，但每行数字非原文照抄，是"凑总额")。
  页面把它当"AI 精算"展示，**建议明细行改用原文数字**或加"estimated"免责。
- ⚠️ **IP 风险（业务决策）**：三篇报告点名真实竞品（Oladance/ClicBot/Lofree）+ 第三方产品图 + 详细逆向 BOM。
  公开发布可能涉版权/法务。**请客户确认**是否接受，或匿名化 / 换自制渲染图。
- **3D 不做**：Blue Ocean 详情页规格书要的 `.glb`/360°/AR **本轮排除**，用静态图。

---

# PART B ｜ TECHNICAL（代码 review 发现）

Review 基线 `a770d61..275b0b3`（前 Agent 的修复）。方法：engineering-craft 触发筛查 + 逐文件 + 独立构建/类型/lint 复验。

| # | 严重度 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| B0 | ✅ 已修 | `.gitignore` | **根因正确**：裸 `data/` 规则误伤 `apps/site/src/data/`，导致原作者 `git add` 静默跳过 → 三页 500。已收窄为 `apps/local-server/data/`，无副作用（`db.local.json` 仍被忽略，无多余文件被跟踪）| — |
| B1 | 🟠 P2 | `components/BlueOceanTeaser.astro:36,39` | **Bug #2 未修**：价格徽章 `absolute right-4 top-4`，`<h3>` 无右内边距 → 长标题被压（`$199`/`$229` 压住 SomniFlow/AeroSense）| 给 `<h3>` 加 `pr-16`（或把徽章移入正常流）|
| B2 | 🟠 P2 | `i18n/content/en-US.md`（teardownTeaser stats）| 首页硬编码 **"78% Avg. Hardware Margin"**，但三篇真实均值 ≈ **67%**（78.39+68.81+53.77)/3）。列表页是动态算的，会算出 67%，与首页对不上 | 首页改 67%（或改文案为 "up to 78%"）|
| B3 | 🟡 P3 | `data/teardownReports.ts` | ClicBot/Lofree 的 `bomBreakdown` 分项是重推的（求和对、逐行非原文）| 见 A4；对齐原文或加 estimated 标注 |
| B4 | 🟡 P3 | `data/teardownReports.ts` + `data/blueOceanProducts.ts` | 各自重复定义 `BomLine` interface | 可抽到 `shared` 或共用类型（非必须）|
| B5 | 🟡 P3 | `i18n/content/en-US.md`（nav）| "Sign In" 配 `/admin`，实际认证岛渲染 `/login`+`/register`，不一致 | 统一入口 |
| B6 | 🟠 P2 | `pages/index.astro` | 缺 4 个 PPTX 板块（OEM Process / Product Capability / Why Choose Us / Certifications&Clients）| 见 A1；`ProcessTimeline`/`HeroVideo`/`WorkflowChain` 已存在可复用，另需新建 3 个区块组件 + 在 `site.ts` 加对应 content 字段 + `en-US.md` 填文案 |
| B7 | 🟠 P2 | 资产 | `Video Project 2.mp4` **171MB**，不能直接上 web | 压到 <10MB（H.264/`ffmpeg`）或走流媒体；生成 poster 图 |
| B8 | 🟡 P3 | `data/*` 图片 | 案例/认证/客户 logo/拆解/蓝海配图**均未落地到 `public/media/`** | 拷贝素材 + 回填路径（配合 A2/A3）|

**构建验证（复验结论）:** `astro build` ✅ 20 页全过；`astro check` ✅ 0 error（5 个 hint 是无关 island 的 `FormEvent` deprecation）；biome ✅。**B0 修复无回归。**

**engineering-craft 触发筛查:** 无 concurrency/CAS、无 env 配置漂移、无第三方 SDK surface、无 secret 删除 —— 本 diff 是纯静态内容 + gitignore + 删死代码，**安全/并发面为零**。（唯一"CAS"命中是文案里 "con**sume**r" 的误报。）

---

## Part C ｜ 实施顺序 & 验收 / Order & Acceptance

**建议顺序:** B1（修 Bug#2，几行 CSS）→ A1 首页重构（B6，最大块）→ A3 Success Stories 纠正 → A2/B8 素材落地 → B7 压视频 → B2/B3/B5 小修。

**验收清单:**
- [ ] `astro build` green，`astro check` 0 error，`biome check` 通过
- [ ] 首页 8 个板块与 PPTX 逐页对应；无 AI 叙事残留；数字统一 20+（无 15+）
- [ ] A2 表内每个素材文件夹都有实际落点，无孤儿素材
- [ ] Success Stories 无「编造事实」（匿名客户/占位指标已处理）
- [ ] 无死链；PC/平板/手机响应式；BOM 表移动端不横向溢出
- [ ] 视频已压缩 + 有 poster；图片转 webp

**需用户/客户先拍板:** ①首页是否移除 Teardown/BlueOcean teasers（A1）②Success Stories 客户具名 & 真实指标（A3）③拆解报告 IP 风险（A4）。
