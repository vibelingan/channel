# 云端接手入口

<!-- formal-blog-latest -->
10月29日：用户要求先补商品自动更新SSG和正式收录，上一轮收尾未完成，当前入口为docs/seo/continuation/README.zh-CN.md。尚未合并main；以下旧收尾安排不再作为执行指令。
已验收基础：文章、助手正式接入、长期凭证、图片传递与预览修复。剩余提交尚未合并main，本轮先补自动更新与收录。先读[收尾与后续任务](docs/delivery/2026-10-28/BRANCH-CLOSEOUT.zh-CN.md)及[当前进度](docs/delivery/README.zh-CN.md)，不要依据旧日志重复开发图片或重新安装助手。代码合并不等于重新部署，实际服务版本仍分别记录。
当前事实和下一步统一记在 [交付进度](docs/delivery/README.zh-CN.md)，先读该页，再读 [会话交接](docs/cloud-handoff/SESSION.zh-CN.md)。早期dummy阶段的限制和待办是历史记录，不能覆盖用户后来的授权，也不能当成当前状态。

- 仓库：vibelingan/channel。原工作分支feat/seo-foundation，不新开分支或worktree，不改其他工作流。
- 早期SEO/Blog已通过c91a16b2整合进main；本次继续整合正式助手、图片和预览修复。test分支为91443842，现站静态页面已通过受控入口40617257076发布2681b003；文章容器、独立导入函数及两机工具各有自己的运行版本，见当前进度。
- [WeCom图文入口](docs/delivery/2026-10-26/wecom/START-HERE.html)、[服务器配置与退出步骤](docs/delivery/2026-10-26/wecom/GUIDE.zh-CN.md)、[群测任务](docs/delivery/2026-10-26/wecom/TEST-PROMPT.zh-CN.md)。两个助手已启用正式工具，网站密钥只在发布机且每小时维护；旧单篇指南仅作历史查证；不重复安装、不代发群消息、不复制本机私有凭证进cloud。
- [环境指南](docs/cloud-handoff/ENVIRONMENT.zh-CN.md)、[CloudBase/MCP权限](docs/cloud-handoff/TOOLS.zh-CN.md)、[技能来源与固定版本](docs/cloud-handoff/SKILLS.zh-CN.md)。仅迁移代码和公开工具来源，不迁移本机登录、密钥或其他项目记忆。

可作为云端新任务的开场消息：

```text
请继续Channel原SEO/Blog工作。先读AGENTS.md、CLOUD_HANDOFF.md、
docs/delivery/README.zh-CN.md和docs/cloud-handoff/SESSION.zh-CN.md，
再核对远端最新源码与实际运行版本。沿用feat/seo-foundation，不开新分支或worktree，
不改pricing或其他工作流。先核对本次收尾PR是否已合入main；现站已经通过受控入口发布预览修复，不要重复做首次dummy部署，
不要用旧程序覆盖现站。
正式交接已完成：固定工作区2，内容机专用MCP通过受限SSH只传文档编号，发布机重新取稿存私有草稿。文档201、202实际保存和重投通过，203两张原图已完成真实上传、排版及私有预览。群内任务由用户发起，不代发消息。
真实发布机已完成配置，先读docs/delivery/2026-10-27/wecom/INSTALLATION-RESULT.zh-CN.md，
不重复安装、不猜其他服务器、不代发群消息。
网站草稿接口已接通；助手只能存私有草稿、查自己的结果，人审核后才公开。
图文交接已接通，重复投递不重复插图；人工编辑后，旧版本插图请求会拒绝，不覆盖人工修改。
CloudBase test实际是客户网站。新云端写入前说明范围、可恢复版本和停止条件，
沿用共享锁，不回灌数据库、不碰别的服务。通用业务函数自动恢复仍关闭。
按环境指南安装锁定工具；工具安装、离线测试、真实云端、生产助手和群测分别记录。
八分钟部署目标、商品变化自动触发/应急跳过、正式文章收录和海外方案仍有后续工作。
中文直接说明谁做了什么、结果和缺口。完成后更新同一进度入口，推送原分支，
核对准确提交的CI；不把先前日志里的中间失败当作最终状态。
```

历史与原交接来源见 [10月22至24日历史](docs/cloud-handoff/HISTORY-2026-10-22-24.zh-CN.md)。
