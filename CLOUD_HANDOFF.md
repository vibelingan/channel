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

下面整段可作为云端新任务的开场消息：

```text
请接手 Channel 的 SEO / Blog 开发。先读 AGENTS.md、CLOUD_HANDOFF.md、
docs/cloud-handoff/SESSION.zh-CN.md 和 docs/cloud-handoff/ENVIRONMENT.zh-CN.md。
核对当前代码包含交接所列提交；沿用 feat/seo-foundation，不另建分支或 worktree，
不改 pricing，不自动合并 main，不改现有部署流程，不操作生产或部署 test。
本次允许继续写代码、跑离线测试，把改动提交并推送到原 SEO 分支，核对该提交的远端 CI。
先运行 bash scripts/cloud-handoff/check.sh；工具未装好则按环境指南补齐。
本地草稿服务及 CloudBase 适配器源码已完成，先读 docs/blog/02-cloudbase-sdk-probe.zh-CN.md、
02-cloudbase-drafts-plan.zh-CN.md 和 NEXT-STEPS.zh-CN.md。16 项实际 SDK 离线传输测试已接入
SDK 总检查；文章集合准备函数单独导出，未加入自动部署，真实资源/权限/并发尚未验收。
下一项是模块 03 的简洁编辑页：沿用 DashboardShell，先打通列表、编辑、保存、重开，
主要操作保留保存草稿和预览，少放无用按钮。先补可视浏览器环境并做真实操作测试，
不能用截图或少量无头脚本代替验收。随后在明确授权的测试范围连接真实 CloudBase 重走流程。
保留权限、重复请求和版本保护；真实集合创建、业务写入和网站部署均不自动执行。
发现设计和当前代码不一致时，修正当前模块并说明，不顺便改造公共请求层或 pricing。
中文直接按汉语习惯解释，先说做了什么、有什么结果、还差什么，不用内部编号代替解释。
每次主动给简短中文 brief：完成内容、实际测试、还差什么、下一步和准确提交/CI；
完成后推送原分支，方便跨端继续，不再等用户重复提醒。
若缺云端权限，继续不依赖权限的开发，不把工具已安装说成线上已验证。
```

本交接包已在本次 Linux 云端实例完成安装和本地检查。新任务仍要核对源码、启动进程和现有权限；本轮结果不代表网站已经发布。
