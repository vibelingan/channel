# 云端接手入口

本次只迁移继续开发所需的上下文和工具，不迁移本机凭证、浏览器账号或其他项目的记忆。

- 仓库：`vibelingan/channel`；继续使用 `feat/seo-foundation`。
- 环境配置和安装命令：[环境指南](docs/cloud-handoff/ENVIRONMENT.zh-CN.md)。
- 当前完成情况、下一步和不能做的操作：[会话交接](docs/cloud-handoff/SESSION.zh-CN.md)。
- CloudBase、MCP 和权限：[工具指南](docs/cloud-handoff/TOOLS.zh-CN.md)。
- 技能来源、版本与本地差异：[技能说明](docs/cloud-handoff/SKILLS.zh-CN.md)。
- 本次实际验证：[交接验收记录](output/cloud-handoff-2026-10-22/README.zh-CN.md)。

下面整段可作为云端新任务的开场消息：

```text
请接手 Channel 的 SEO / Blog 开发。先读 AGENTS.md、CLOUD_HANDOFF.md、
docs/cloud-handoff/SESSION.zh-CN.md 和 docs/cloud-handoff/ENVIRONMENT.zh-CN.md。
核对当前代码包含交接所列提交；沿用 feat/seo-foundation，不另建分支或 worktree，
不改 pricing，不自动合并 main，不改现有部署流程，不操作生产或部署 test。
本次允许继续写代码、跑离线测试，把改动提交并推送到原 SEO 分支，核对该提交的远端 CI。
先运行 bash scripts/cloud-handoff/check.sh；工具未装好则按环境指南补齐。
下一项是 docs/blog/02-admin-drafts.zh-CN.md 的 BLOG-D1：
沿用现有后台身份校验，完成草稿服务、Repository 合同、本地适配器及后台 action 接线，
先审查实际入口和设计，再写代码。真实 CloudBase 集合创建和线上验收仍未获本次授权。
发现设计和当前代码不一致时，修正当前模块并说明，不顺便改造公共请求层或 pricing。
中文直接按汉语习惯解释，先说做了什么、有什么结果、还差什么，不用内部编号代替解释。
每次交付列出提交、实际测试结果、是否有 UI 变化，以及尚未接线或上线的部分。
若缺云端权限，继续不依赖权限的开发，不把工具已安装说成线上已验证。
```

本交接包可以在干净的 Linux checkout 使用；云端实例的实际运行验收由新会话补做。
