# 公司主体名称更正

范围：从 main@b3d63ac1 新建 fix/company-entity-name，仅更正网站公司主体展示；首页九版块、分类数据、账号及内容运营另行讨论。

已检查 apps/site/src/i18n/content/en-US.md、layouts/BaseLayout.astro、components/SiteHeader.astro、components/SiteFooter.astro、components/OurTeamSection.astro、islands/ai/AssistantWidget.tsx 及相应现有测试。将公开公司名称、标题、分享资料、图片说明和辅助阅读名称统一为 Diversity Innovations Limited。

依据客户提供的《SupplyChainsAI网站改版与GEO技术工单》所载主体资料，将 Organization 成立年份改为 2014；工厂介绍把“2004 年公司成立”更正为团队拥有 20 多年经验。保留现有 CHANNEL 图标和布局、备案号、联系方式及业务流程。

措辞核对：用“团队拥有 20 多年经验”区分团队经历与公司成立年份，未采用整份首页改版文案。客户资料须由客户提供和确认，技术侧负责录入及展示。现有 Alibaba 导入已有分类映射，不把 PDF 所述问题当作已确认的线上故障。

本地验证：网站类型检查 0 errors；现有名称、素材与分享信息测试 41 项通过；本地模拟产品构建成功，21 个 HTML 页面没有旧公司名，Organization 名称、法定名与年份逐页检查通过。该模拟产品仅用于本地验证，发布必须使用现有正式数据发布流程。
