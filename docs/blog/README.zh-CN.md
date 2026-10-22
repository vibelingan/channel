# Blog：按模块交付

2026-10-22。沿用原 `feat/seo-foundation`，不创建分支或 worktree，不部署现有 test 目标，也不操作生产。此前 10 月 16/18 日方案确定了 Tiptap OSS、结构化正文、草稿与公开版本分离、Hermes 只导入草稿；当时的 `BLOG-1` 范围过大，尚未形成逐模块的实现细节。

本轮先补齐下面五个模块的设计和验收，再实现第一部分。第一部分不会给现有后台增加一个尚不可用的菜单，也不改变商品、价格、询盘或同步流程。

| 模块 | 交付内容 | 独立验收要求 |
| --- | --- | --- |
| [01 文章核心](01-content-core.zh-CN.md) | 有版本的正文 JSON、Tiptap JSON 转入/转出、受限 HTML/纯文本输出、草稿修订与待发布快照 | 不依赖浏览器或编辑器实例；未知结构不丢弃；编辑草稿不改变公开版本 |
| [02 后台草稿服务](02-admin-drafts.zh-CN.md) | 独立文章存储、版本条件写入、权限、列表/保存/预览 API | 两个人保存不会互相覆盖；访客和导入账号不能越权；真实存储与本地适配器分别验收 |
| [03 编辑器和预览](03-editor-preview.zh-CN.md) | 现有 DashboardShell 内嵌 Tiptap OSS、媒体选择、草稿预览 | 编辑后重开不丢内容；私有图片用鉴权字节和 Blob URL；桌面/手机截图验收 |
| [04 公开文章与 SEO](04-publication-seo.zh-CN.md) | 发布指定修订、文章/列表初始 HTML、Article SEO、更新/撤回和公开媒体引用 | 构建成功不等于发布成功；真实 URL、sitemap、缓存及撤回结果都核对 |
| [05 Hermes 草稿接入](05-hermes-drafts.zh-CN.md) | 受限服务凭证、Markdown 转入、幂等导入和可登录的编辑链接 | 重试不重复建文，不覆盖人工编辑；Hermes 没有发布权限 |

每个模块只写自己的低层设计和 MIU，不再重复一份全量接口表。01 可独立交付；02 依赖 01，03 依赖 01/02，04 依赖文章核心、媒体接入及 SEO 发布链，05 依赖 01/02。Meta→Action、多人协作、收费扩展、Pages、AI 写作和定时发布不属于一期。

当前实际状态：01 的 `packages/articles` 已写代码，37 项行为测试和 TypeScript 检查通过；02 的本地草稿服务、管理员 action 和本地存储已实现，新增 21 项行为测试通过，见[草稿服务记录](02-admin-drafts-worklog-2026-10-22.zh-CN.md)。02 的真实 CloudBase 存储尚未接入，03–05 仍只有设计。后台编辑器和网站文章尚不可用。设计中修正的问题见[本轮审阅](DESIGN-REVIEW.zh-CN.md)。

通用部分放在 `packages/articles`，与站点后台、CloudBase 和 Hermes 分开。正文节点用清楚的类型、属性和版本规则扩展，不能从文章 JSON 执行 JavaScript 或任意请求。后台 UI 是业务组件，持久化由后端适配器负责，网站公开页不加载编辑器包。

Tiptap 官方支持保存 JSON，以及不创建编辑器实例的静态渲染：[JSON 持久化](https://tiptap.dev/docs/guides/output-json-html)、[Static Renderer](https://tiptap.dev/docs/editor/api/utilities/static-renderer)。本模块先实现本站允许的节点及媒体映射；编辑器接入时必须使用同一节点范围做真实 getJSON/setContent 联测，不能把本轮格式测试冒充编辑器 UI 已验收。

部署和 SSG 的待执行事项单独放在 [pricing 合并后的验收与清理计划](../seo/execution/LIVE-RESUME-AND-CLEANUP.zh-CN.md)。Blog 开发不因此开启发布或恢复开关。
