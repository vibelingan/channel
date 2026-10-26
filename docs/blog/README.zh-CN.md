# Blog：按模块交付

当前进度统一见 [共同进度与接手记录](NEXT-STEPS.zh-CN.md)，本地和云端交付都更新同一页。

2026-10-26。文章核心、现有后台内的编辑器、图片、私有预览与直接发布已经实现，并完成真实网站的发布、更新、撤回检查。日常文章由 Astro 按需返回 HTML，不等待 GitHub 内容构建。验收文章暂时禁止收录。准确版本、结果和未完成项见上面的共同记录。

本地内容助手正在接入独立草稿接口；不修改 HermesInfra 或企业微信群。它只创建私有草稿，管理员仍在原后台编辑、预览并决定发布。真实模型与页面验收尚待完成，代码存在不代表已接通。

下面按功能列出五个模块；准确进度只在共同记录更新。后台沿用现有 DashboardShell 和请求层，文章图片放在独立内部集合，不改变商品、价格、询盘或同步流程。

| 模块 | 交付内容 | 独立验收要求 |
| --- | --- | --- |
| [01 文章核心](01-content-core.zh-CN.md) | 有版本的正文 JSON、Tiptap JSON 转入/转出、受限 HTML/纯文本输出、草稿修订与待发布快照 | 不依赖浏览器或编辑器实例；未知结构不丢弃；编辑草稿不改变公开版本 |
| [02 后台草稿服务](02-admin-drafts.zh-CN.md) | 独立文章存储、版本条件写入、权限、列表/保存/预览 API | 两个人保存不会互相覆盖；访客和导入账号不能越权；真实存储与本地适配器分别验收 |
| [03 编辑器和预览](03-editor-preview.zh-CN.md) | 现有 DashboardShell 内嵌 Tiptap OSS、媒体选择、草稿预览 | 编辑后重开不丢内容；私有图片用鉴权字节和 Blob URL；桌面/手机截图验收 |
| [04 公开文章与 SEO](04-publication-seo.zh-CN.md) | 发布指定修订、文章/列表初始 HTML、Article SEO、更新/撤回和公开媒体引用 | 构建成功不等于发布成功；真实 URL、sitemap、缓存及撤回结果都核对 |
| [05 Hermes 草稿接入](05-hermes-drafts.zh-CN.md) | 受限服务凭证、Markdown 转入、幂等导入和可登录的编辑链接 | 重试不重复建文，不覆盖人工编辑；Hermes 没有发布权限 |

每个模块只写自己的低层设计和 MIU，不再重复一份全量接口表。01 可独立交付；02 依赖 01，03 依赖 01/02，04 依赖文章核心、媒体接入及 SEO 发布链，05 依赖 01/02。Meta→Action、多人协作、收费扩展、Pages、AI 写作和定时发布不属于一期。

原始后端与 SDK 依据保存在 [草稿记录](02-admin-drafts-worklog-2026-10-22.zh-CN.md) 和 [SDK 核对](02-cloudbase-sdk-probe.zh-CN.md)。编辑页结果见 [E1 记录](03-editor-worklog-2026-10-23.zh-CN.md)，图片与私有预览见 [E2 记录](03-media-worklog-2026-10-23.zh-CN.md)。这些本地检查不代表真实 CloudBase 或网站已验收；原设计审阅见 [设计记录](DESIGN-REVIEW.zh-CN.md)。

通用部分放在 `packages/articles`，与站点后台、CloudBase 和 Hermes 分开。正文节点用清楚的类型、属性和版本规则扩展，不能从文章 JSON 执行 JavaScript 或任意请求。后台 UI 是业务组件，持久化由后端适配器负责，网站公开页不加载编辑器包。

Tiptap 官方支持保存 JSON，以及不创建编辑器实例的静态渲染：[JSON 持久化](https://tiptap.dev/docs/guides/output-json-html)、[Static Renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer)。本模块先实现本站允许的节点及媒体映射；编辑器接入时必须使用同一节点范围做真实 getJSON/setContent 联测，不能把本轮格式测试冒充编辑器 UI 已验收。

部署和 SSG 的待执行事项单独放在 [pricing 合并后的验收与清理计划](../seo/execution/LIVE-RESUME-AND-CLEANUP.zh-CN.md)。Blog 开发不因此开启发布或恢复开关。
