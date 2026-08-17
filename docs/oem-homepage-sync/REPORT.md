# 首页与 OEM Development 内容同步审计

## 结论与实现决定

OEM Development 页不是整页都旧：它的“传统流程 vs AI 智能流程”已经直接复用首页内容，目前是同步的。真正的版本断层在这个模块之后：OEM 页仍是早期“传统一站式代工厂”叙事，而首页已经更新为“AI 驱动的产品开发 + 制造 + 全球供应链伙伴”。

本次实现直接把首页作为唯一的当前品牌与内容来源，OEM 页复用首页已有组件和内容，不再维护第二套平行叙事。OEM 页只保留自己的 SEO metadata、项目提交表单和工厂视频。

## UI 设计判断

**不需要新的 UI 设计。** 首页已经提供完整的视觉、组件和响应式方案，本次是既有组件重组与内容同步，不新增页面类型、交互模式或视觉语言。

实现必须复用 `AIHero`、`ServiceGridSection`、`OemProcessSection`、`FactorySection`、`OurTeamSection`、`WhyChooseUsSection`、`QualityTestingSection`、`CertificationsSection` 和 `CTASection`。不得为 OEM 页复制或另画同类组件。

## 主要不同点

| 优先级 | 内容 | 首页当前口径 | OEM Development 当前口径 | 建议 |
|---|---|---|---|---|
| P0 | 品牌定位 | AI-Powered Product Development & Fast OEM Delivery；不只生产，也覆盖市场洞察、成本预估、虚拟仿真、Pre-QC 和全球物流 | One-stop OEM development；核心仍是设计、开模、打样、生产、运输 | OEM Hero 与段落总述改成首页的新定位，避免用户从首页进入 OEM 页后感觉换了一家公司 |
| P0 | 开发流程 | 具体 10 步：草图、外观、结构、电路、原型、开模、PCBA 量产、试模、试产、QC | 通用 6 步：需求、概念、样品、批量生产、质检、运输 | OEM 页改为复用首页 10 步流程；旧 6 步不应继续作为第二套“标准流程” |
| P0 | AI 工作方式 | 传统流程与 AI 流程的 7 步对比，强调主动洞察、前置估价、虚拟仿真和 Pre-QC | 该模块已经复用首页内容 | 保持现状，不重复维护；这是目前唯一已同步的主体模块 |
| P1 | 实力数字 | 20+ 年、40+ 工程师、5000+ m²、40+ 国家 | 20+ 年、100+ 供应链伙伴、Flexible MOQ | 统一采用首页四组数字；删除 OEM 旧版 `100+` 伙伴和 Flexible MOQ |
| P1 | 团队与服务对象 | 多语言销售、采购、工程团队；服务全球品牌、进口商、经销商和零售商 | 只提 Dedicated Project Manager | 采用首页团队与全球贸易能力；删除 OEM 旧版 Dedicated Project Manager 承诺 |
| P1 | 质量体系 | Pre-QC 前置风险识别、生产过程检查、出口前最终验证 | 每阶段检查；另称按 agreed AQL standards 验货 | 采用首页质量口径；删除 OEM 旧版 AQL 表述 |
| P1 | 认证与客户证明 | CE、EMC、FCC、JD；国际合规认证、产品测试报告及客户 Logo | 只写 CE、FCC、RoHS 和市场认证指导，没有展示证明 | 直接复用首页认证/客户证明；删除 OEM 旧版 RoHS 与认证指导表述 |
| P1 | 合作关系 | 长期品牌共同成长，持续迭代和成本优化 | 长期伙伴，但内容主要是代工执行 | OEM 页 Why Choose Us 改成首页五项新优势，不再维持另一套旧理由 |
| P2 | 产品范围 | 首页当前不再用产品家族定义能力 | Plastic、Electronics、Headphones、Consumer Goods、Hardware、Promotional Products 六大类 | 删除旧六类营销能力区；保留表单中的同名询盘分类选项 |
| P0 | 24 小时承诺 | 24 小时内提供 OEM solution | 24 小时内回复询盘 | OEM 主页面 CTA 直接复用首页原文；提交成功文案继续保留“24 小时内回复”，不在本任务扩大承诺范围 |

## 建议的 OEM 页新结构

1. Hero：直接使用首页 Hero 内容和 `AIHero`；仅把链接改为 OEM 页内的 `#submit` 与 `#factory`。
2. What We Do：继续复用现有“传统 vs AI”共享模块，不另建副本。
3. Development Process：直接复用首页 10 步流程，删除旧 6 步版本。
4. Factory & Team Strength：复用 20+ 年、40+ 工程师、5000+ m²、40+ 国家，并保留 OEM 页现有工厂视频。
5. Why Choose Us：改为首页五项新优势，重点讲主动孵化、快速迭代、全球供应链、Pre-QC 和长期共同成长。
6. Quality & Certifications：复用首页质量、认证和全球客户内容，作为营销承诺的证据区。
7. Submit Your Project：复用首页 `CTASection`，保留现有 OEM 表单字段、上传流程、接口和结果页。

## 对远端实现 Agent 的固定决定

以下内容不交给实现 Agent 判断：

1. 首页 `apps/site/src/i18n/content/en-US.md` 是本任务的内容 source of truth；不要改首页原文。
2. 从 OEM 活动页面和 OEM 内容模型删除旧的 `100+ Supply Chain Partners`、Flexible MOQ、Dedicated Project Manager、AQL、RoHS 和“六大产品家族”营销表述。
3. `submit.fields[].options` 中的产品类别是询盘分类字段，不等同于营销能力声明；本任务不得删除或改名。
4. 首页已有的 CE、EMC、FCC、JD、AI、Pre-QC、团队和全球交付表述原样同步，不由实现 Agent 重新解释或润色。
5. OEM 主页面使用首页 CTA 原文；`submit.successBody` 和 `/oem_submit_result` 的“24 小时内回复”原文保持不变。
6. 保留 `/oem#submit` 和 `/oem#process`，因为 Portfolio、上传 E2E 和 mutation E2E 正在使用；不得改成新锚点。
7. 保留 OEM 专属 `/media/oem-factory.mp4` 与 `/media/factory-oem.webp`，不得被首页 `/media/oem/factory-video.mp4` 覆盖，也不得同时渲染两个工厂视频。
8. `/` 首页的内容、组件调用、锚点和默认工厂媒体不得发生变化。

## 可直接执行的同步项

实现范围如下：

- OEM 页继续读取首页共享的 Traditional-versus-AI 模块。
- OEM 页 6 步流程改为复用首页 10 步流程，消除两套标准流程。
- OEM 页复用首页的工厂/团队、质量、认证组件，减少未来再次漂移。
- 保留 OEM 页专属的工厂视频和项目提交表单。
- 所有共享营销内容只从首页内容源读取，OEM 内容文件不再保存平行副本。

## 本次未做

- 未修改任何线上页面或营销文案。
- 未把旧 OEM 内容自动覆盖成首页内容。
- 未独立验证首页营销内容的业务事实；本任务按用户指示把较新的首页作为同步基准。