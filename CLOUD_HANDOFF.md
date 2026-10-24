# 云端接手入口

本次只迁移继续开发所需的上下文和工具，不迁移本机凭证、浏览器账号或其他项目的记忆。

- 仓库：`vibelingan/channel`；继续使用 `feat/seo-foundation`。
- 环境配置和安装命令：[环境指南](docs/cloud-handoff/ENVIRONMENT.zh-CN.md)。
- 当前完成情况、下一步和不能做的操作：[会话交接](docs/cloud-handoff/SESSION.zh-CN.md)。
- CloudBase、MCP 和权限：[工具指南](docs/cloud-handoff/TOOLS.zh-CN.md)。
- 技能来源、版本与本地差异：[技能说明](docs/cloud-handoff/SKILLS.zh-CN.md)。
- 原交接包验证：[交接验收记录](output/cloud-handoff-2026-10-22/README.zh-CN.md)。
- 云端草稿服务验证：[本轮结果](docs/blog/02-admin-drafts-worklog-2026-10-22.zh-CN.md)。
- CloudBase 草稿存储与跨端接手：[SDK 核对](docs/blog/02-cloudbase-sdk-probe.zh-CN.md)、[实施计划](docs/blog/02-cloudbase-drafts-plan.zh-CN.md)、[后续顺序](docs/blog/NEXT-STEPS.zh-CN.md)。
- 本轮完整结果：[CloudBase 草稿存储交付记录](docs/blog/02-cloudbase-worklog-2026-10-22.zh-CN.md)。
- 最新发布任务后端与 dummy 计划：[P2 第一段交付](docs/blog/04-publication-tasks-worklog-2026-10-23.zh-CN.md)。
- 公开文章页面、截图和检查：[P1 交付记录](docs/blog/04-public-pages-worklog-2026-10-23.zh-CN.md)。当前任务始终以共同进度表为准。

下面整段可作为云端新任务的开场消息：

```text
请接手 Channel 的 SEO / Blog 开发。先读 AGENTS.md、CLOUD_HANDOFF.md、
docs/cloud-handoff/SESSION.zh-CN.md 和 docs/cloud-handoff/ENVIRONMENT.zh-CN.md。
核对当前代码包含交接所列提交；沿用 feat/seo-foundation，不另建分支或 worktree，
不改 pricing，不自动合并 main，不改现有部署流程，不部署正式网站。
继续开发、测试和推送原 SEO 分支，核对准确提交的 CI。用户已授权隔离 Blog dummy 的真实部署验收；先读本轮发布任务计划，核对现场资源、说明范围/恢复/停止条件后再写云端。
先运行 bash scripts/cloud-handoff/check.sh；工具未装好则按环境指南补齐。
本地草稿服务及 CloudBase 适配器源码已完成，先读 docs/blog/02-cloudbase-sdk-probe.zh-CN.md、
02-cloudbase-drafts-plan.zh-CN.md 和 NEXT-STEPS.zh-CN.md。26 项实际 SDK 离线传输测试（16 项草稿、4 项媒体、6 项发布/隔离）已接入
SDK 总检查；文章集合准备函数单独导出，未加入自动部署，真实资源/权限/并发尚未验收。
模块 03 的 E1 编辑页及 E2 图片上传/鉴权预览已接入并完成本地验收。先读
docs/blog/NEXT-STEPS.zh-CN.md、03-media-worklog-2026-10-23.zh-CN.md 和
04-public-pages-worklog-2026-10-23.zh-CN.md。模块 04 的 P1 公开列表/详情、静态图片和 SEO
也已完成本地验收。P2 任务后端第一段已实现；下一步及实际验证以 NEXT-STEPS 和 04-publication-tasks-plan.zh-CN.md 为准。
不要把候选标成 accepted 来通过现有校验，不部署现有 test 目标。
以它们记录的状态和下一步为准，不重写已完成模块。文章媒体使用内部 articleMedia 集合；
不是商品 images 集合。隔离 dummy 需核对当前授权及范围；不能把离线 SDK 传输当真实云端结果。
保留权限、重复请求和版本保护，不把 dummy 授权扩大到业务数据或正式站点。
发现设计和当前代码不一致时，修正当前模块并说明，不顺便改造公共请求层或 pricing。
中文直接按汉语习惯解释，先说做了什么、有什么结果、还差什么，不用内部编号代替解释。
每次主动给简短中文 brief：完成内容、实际测试、还差什么、下一步和准确提交/CI；
完成后推送原分支，方便跨端继续，不再等用户重复提醒。
若缺云端权限，继续不依赖权限的开发，不把工具已安装说成线上已验证。
```

本交接包已在本次 Linux 云端实例完成安装和本地检查。新任务仍要核对源码、启动进程和现有权限；本轮结果不代表网站已经发布。
