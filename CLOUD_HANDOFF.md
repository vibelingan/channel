# 云端接手入口

<!-- formal-blog-latest -->
当前已清理发布机上本轮新增的写作职责；网站凭证与草稿工具保留。正式凭证维护及按 KB 文档去重的代码已准备，尚未云端激活。先读 docs/delivery/2026-10-27/wecom/FORMAL-USE-STATUS.zh-CN.md，不转发旧单篇包给内容助手，不重复首轮安装或提前群测。

2026-10-26更新。当前事实和下一步统一记在 [交付进度](docs/delivery/README.zh-CN.md)，先读该页，再读 [会话交接](docs/cloud-handoff/SESSION.zh-CN.md)。早期dummy阶段的限制和待办是历史记录，不能覆盖用户后来的授权，也不能当成当前状态。

- 仓库：vibelingan/channel。原工作分支feat/seo-foundation，不新开分支或worktree，不改其他工作流。
- 本轮SEO/Blog已整合进main；c91a16b2包含工具修正及交付材料。test实际网站来源91443842，正常Deploy Test 40317622122成功。后续工具和文档没有改变网站业务代码，不能把Git最新SHA当成所有服务都已部署的SHA。
- [WeCom图文入口](docs/delivery/2026-10-26/wecom/START-HERE.html)、[服务器配置与退出步骤](docs/delivery/2026-10-26/wecom/GUIDE.zh-CN.md)、[群测任务](docs/delivery/2026-10-26/wecom/TEST-PROMPT.zh-CN.md)。网站侧已登记14天群测凭证，真实发布机xianqu-agent2已完成接线，安装与实际MCP验证见交付进度；不重复安装、不代发群消息、不复制本机私有凭证进cloud。
- [环境指南](docs/cloud-handoff/ENVIRONMENT.zh-CN.md)、[CloudBase/MCP权限](docs/cloud-handoff/TOOLS.zh-CN.md)、[技能来源与固定版本](docs/cloud-handoff/SKILLS.zh-CN.md)。仅迁移代码和公开工具来源，不迁移本机登录、密钥或其他项目记忆。

可作为云端新任务的开场消息：

```text
请继续Channel原SEO/Blog工作。先读AGENTS.md、CLOUD_HANDOFF.md、
docs/delivery/README.zh-CN.md和docs/cloud-handoff/SESSION.zh-CN.md，
再核对远端最新源码与实际运行版本。沿用feat/seo-foundation，不开新分支或worktree，
不改pricing或其他工作流。本轮已经合入main并正常发布test；不要重复做首次dummy部署，
不要用旧程序覆盖现站。
下一步等待内容助手自查正确工作区和任务接口，再完成 VibeKB 取稿交接并联测；
真实发布机已完成配置，先读docs/delivery/2026-10-27/wecom/INSTALLATION-RESULT.zh-CN.md，
不重复安装、不猜其他服务器、不代发群消息。
网站草稿接口已接通；助手只能存私有草稿、查自己的结果，人审核后才公开。
当前接口不自动导入Agent图片，人可在后台上传。
CloudBase test实际是客户网站。新云端写入前说明范围、可恢复版本和停止条件，
沿用共享锁，不回灌数据库、不碰别的服务。通用业务函数自动恢复仍关闭。
按环境指南安装锁定工具；工具安装、离线测试、真实云端、生产助手和群测分别记录。
八分钟部署目标、商品变化自动触发/应急跳过、正式文章收录和海外方案仍有后续工作。
中文直接说明谁做了什么、结果和缺口。完成后更新同一进度入口，推送原分支，
核对准确提交的CI；不把先前日志里的中间失败当作最终状态。
```

历史与原交接来源见 [10月22至24日历史](docs/cloud-handoff/HISTORY-2026-10-22-24.zh-CN.md)。
