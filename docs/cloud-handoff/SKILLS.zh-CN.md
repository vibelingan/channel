# 哪些技能带到云端

只从已核对、用户授权安装的 GitHub 仓库下载，不复制本机私有技能目录。安装脚本固定完整提交和归档 SHA-256，不使用浮动 main/latest，不运行上游安装脚本；保存上游许可证或明确的原始声明。下载结果放在忽略提交的 `.agents/skills/`，源码、版本和校验值由 `skills.lock.json` 重建。

| 技能 | GitHub 来源 | 使用时机 |
| --- | --- | --- |
| cloudbase 及其全部 references | [tencentcloudbase/cloudbase-skills](https://github.com/tencentcloudbase/cloudbase-skills/tree/fe84b6ae5cc0be1166a7cd4db20db9da17822f20/skills/cloudbase) | 修改 SDK/函数/存储/权限前读对应参考页；收尾按对应审查要求检查 |
| humanizer | [blader/humanizer](https://github.com/blader/humanizer/tree/8c307f367c91bd974002f10f2be2965d642c13df) | 所有用户可见说明，配合本仓库 AGENTS.md 的中文表达要求 |
| archify | [tt-a1i/archify](https://github.com/tt-a1i/archify/tree/25cf37080fc8b1dbe758a4efc3935b55f3327083/archify) | 用户要求画图或实际设计需要更新时；当前服务开发不必重画图 |
| handoff、code-review、tdd、diagnosing-bugs、codebase-design、research | [mattpocock/skills](https://github.com/mattpocock/skills/tree/5beb35b040e3de97e54fa9e386d7e42d15c295c2/skills) | 交接、审查、测试、排错或相关设计，按实际任务选用 |
| dev-pipeline | [orocsy/dev-pipeline](https://github.com/orocsy/dev-pipeline/tree/cb3cf82436aa895a9a38bf16ef7a5efed993b209) | 新功能使用 full pipeline 对照需求、设计、测试、审查、交付；当前 Codex 直接读取命令说明和本仓库适配入口 |
| engineering-craft | [orocsy/engineering-craft](https://github.com/orocsy/engineering-craft/tree/9851782b7bc318cdf985d2888a12e15f4e55489c) | 先读 INDEX.md，再读并发、权限、验证、跨文件接口等相关规则；与本仓库自己的 ENGINEERING_CRAFT.md 一起使用 |

这里共 11 个顶层技能，CloudBase 的参考技能包含在同一目录。原有归档约 51 MiB，主要来自 archify 上游仓库；新增两个工作流归档合计约 0.82 MiB。只解出选中的技能文件。重跑安装会核对现有目录是否一致，不重复覆盖。网络无法下载时不能声称已安装，可先读仓库内设计和规则继续不依赖该技能的工作。

dev-pipeline 是 Claude Code 插件，没有顶层 SKILL.md；安装器加入本仓库维护的 [Codex 入口](dev-pipeline-codex.SKILL.md)，保留整个固定版本插件供读取。它不会注册 Claude 的斜杠命令、自动钩子、多代理团队或全局配置。Engineering Craft 原本就有技能入口，可以直接读取。本轮已经安装并实际使用这两个版本；安装器的 11 项离线测试及重复安装检查通过。

dev-pipeline 的 README 写明不允许再分发，因此只按用户授权装入忽略提交的工作区，不把上游快照提交到 Channel。Engineering Craft 的 MIT 声明在 SKILL.md 中；两者分别保存原始 README / SKILL.md 为 UPSTREAM-NOTICE，没有擅自改成同一种许可证。

用户要求将 full pipeline 作为参考并允许判断；项目 AGENTS.md 仍限制分支、代理和现场操作。沿用已批准设计、当前会话直接审查、只推送原 SEO 分支；没有新 UI 时记录视觉检查不适用，未做的云端验收明确保留。不能把所有上游阶段都写成已运行，也不为了模板重复请求已给出的批准。

本轮对比发现，本机 humanizer、archify、CloudBase、handoff 的 SKILL.md 与当前 GitHub 版本不完全相同。因此迁移的是**有版本记录的上游技能**，不是宣称与本机逐字一致的副本。本机新增的中文沟通要求属于用户已明确下达的项目要求，直接保留在 AGENTS.md，不伪装成上游技能。其他本地独有扩展不复制。

本机专用的 agentic-delivery-loop、fable-operating-manual 和无法确认 GitHub 来源的个人技能不打包，也不要求云端靠一个失效的本机绝对路径才能工作。当前交付必须遵守的现成设计、验证顺序、范围和用户决定已写入仓库；不把另一项目的私人知识当作本项目“记忆”。

## 技能不覆盖项目要求

上游技能是通用建议，使用时必须对照真实项目和用户授权：

- CloudBase 通用示例中可能建议 SPA 的 `errorDocument=index.html`，本项目已有专用 404 修复，不得改回首页兜底。
- 不因通用“先配置后台资源”的建议，在当前仅允许离线开发时创建线上集合或改认证。
- 不因审查技能建议使用 agents 就启动子 agent；用户要求单一工作流，未经明确要求不委派。
- 不照上游贡献说明新开分支/PR；继续原 SEO 分支。
- handoff 默认写系统临时目录；本次用户明确要求可从 GitHub 接手，交接文件因此提交仓库。
- 云端缺少桌面浏览器时不能伪造截图验收。先判断当前功能是否需要浏览器；需要但不能运行则明确记录缺口。

OpenAI 说明仓库 `.agents/skills` 是可发现的技能位置；新任务若未加载，可直接读安装目录文件，不能只报告一个技能名称就算执行了。[技能位置说明](https://learn.chatgpt.com/docs/build-skills)。
