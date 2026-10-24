# 模块 04 / D1 static-canary 验证记录

范围：实现受控人工入口、本地验证、推送同一 SEO 分支并核对远端 CI。未执行线上 canary 或部署；整站 D1、失败运行接管和 D2 自动恢复仍未开放。

## 基线与共享边界

2026-10-21 fetch 后：SEO 起点 `df202039a31d56ef5e0f36700fafb6173937bb45`；`origin/main=37bcea5b38284210159e95f8d10f3a9b5cf2ee44`；pricing `39705e2323d51d4aa79f1240d66f65608f407649`；product-sync `bcee8f2f454f0ee4144f74655c93e3ff18f4420a`。本模块新增运行文件与这两个远端 ref 没有已提交路径重叠；这不代表以后合并不再需要核对，也不涵盖其他 worktree 未提交内容。

始终在 `feat/seo-foundation`，没有新建分支、worktree 或 PR，没有编辑其他工作区。验证副本来自同一 HEAD 的 Git archive，位于 `output/seo-module-04-2026-10-21/source`，没有 `.git`。现有 Deploy Test、E2E、AI CloudRun、部署脚本、package/lockfile 和业务 schema 不变。offline workflow 只补充新人工入口的 PR 路径触发条件，不加入云凭证。

## 交付文件与责任

| 文件 | 责任 |
| --- | --- |
| `.github/workflows/seo-static-canary.yml` | 仅人工触发，共用目标锁，归档先于写入，按步骤传入凭证 |
| `scripts/run-static-canary.mjs` | 固定 Actions 身份和目标、同 SHA 成功 CI、参数选择与证据输出 |
| `scripts/release/static-canary-policy.json` | 固定目标、ref、前缀和权限审查指纹；当前 enabled=false |
| `scripts/release/github-source.mjs`、`extract-canary.py` | GitHub 真实元数据、原始 attempt、ZIP digest 和安全解包 |
| `scripts/release/canary.mjs` | 固定 A/B 数据包、A1 校验和 30 分钟计划 token |
| `scripts/release/canary-provider.mjs` | SDK 前缀清单、已有控制集合和权限只读检查 |
| `scripts/release/orchestrator.mjs` | 只读 plan、持锁重验、A2/C1 执行、B1 提交和未知状态停止 |
| `scripts/release/state.mjs` | 新增仅 canary 可用的 initialize；site 仍要求已有基线 |
| `scripts/hosting-recovery.mjs` | 新候选从 A1 candidate 进入 A2，避免伪造 accepted seal |

没有把普通部署切换到这套执行器，也没有为业务后台增加恢复按钮。UI、商品详情、价格、RFQ、Blog 和 Hermes 没有变更，因此没有新增业务 UI 截图。

## 测试和审查

测试覆盖首次 A、发布 B、指定 A 恢复、新 activation、site 激活保持原样、无函数/删除/业务数据动作；dry plan 不取得租约，关闭开关在凭证/网络使用前拒绝 execute；已占用前缀、现场内容漂移、错误激活、过期 token 和排队时激活变化全部阻止写入；SDK 失败保留未决状态并阻止重试。

归档侧覆盖仓库/分支/事件/SHA/run/attempt/artifact 身份、过期和 digest、精确 CI、原始 attempt 的可追溯性、存储下载不带 GitHub token、四个成员和链接/重复/越界/额外脚本/超限拒绝。控制集合必须预先存在，读取失败不能偷偷创建；安装的 Manager 实际方法经 transport fixture 验证。

首次 RED：canary initialize 被原 B1 的 INVALID_RUN_KIND 拒绝，两项测试失败；加入 canary-only initialize 后通过。新模块导入的 RED 和后续 GREEN 日志也保存在 output。先后发现并修正了测试 fixture 缺少 SDK 所需 Databases 元数据，以及旧 plan workflow 被 rerun 后应读取原始 attempt 的来源问题。没有放宽来源或状态校验。

本机旧依赖的 FileProvider 读取卡在 lodash.isplainobject/package.json，已定位到本次两个测试进程的相同文件路径。仅停止本次测试，在本轮导出副本执行 frozen/offline/ignore-scripts 安装后继续。没有改依赖版本或清理其他工作区。SDK gate 和回环 HTTP 测试需要沙箱外本地端口权限；这不涉及云端写入。

最终本地：默认回归 3044 项，3041 通过、3 项既有跳过、0 失败；根目录 690 项含本次 28 项新测试。A/B/C/D 定向 243 项全部通过，lint 838 文件通过，CloudBase SDK gate 通过。故意移除 canary-only initialize 限制时，site 门禁测试失败；恢复原字节后重新回归通过。

本地和远端结果由本模块 `output/seo-module-04-2026-10-21/local-result.json`、`remote-result.json` 和交付记录绑定具体提交。远端 CI 绑定最终提交记录，未执行 F1 不能写成“线上恢复通过”。

## SDK、平台与文字核对

Context7 在本次会话不可用。读取 CloudBase 官方 manager hosting/database/permission 文档，以及安装的 Manager 5.9.1 的 findFiles、checkCollectionExists、describeResourcePermission、describeEnvAuthzConfig 实现和类型。新适配继续使用 C1 已核验的上传方法，没有新增手写 SDK shim。旧权限接口已被官方标为 deprecated，故不能单独以 ADMINONLY 判定有效权限；执行还需固定审查指纹和现场权限验收。

GitHub 依据：[REST artifact 元数据与 digest](https://docs.github.com/en/rest/actions/artifacts)、[workflow_dispatch 默认分支要求](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)、官方 actions/toolkit 的 ZIP 生成实现。未在默认分支注册的 workflow 不冒充已可点击的线上恢复工具。

文字实际检查了本模块页、模块索引和交付记录。把易误导的“无数据库写入”改为“只写四个发布控制集合，不改业务数据”；把“恢复已完成”限定为“本地闭环通过，线上 F1 未跑”。对照了 workflow 触发器、policy 开关、实际调用路径、固定上传清单和 B1 激活范围。

## 开放前仍需完成

按模块页的写入范围、恢复方案和停止条件做一次现场审查：控制集合及有效权限、唯一目标/前缀、现有缓存/404、排除其他写入的窗口、默认分支入口注册。当前 pin 的目标还不是线上演练批准记录。通过后才更新 policy 并生成正式 plan，再进行 F1 的 A/B/A；不在本轮顺便写云端。

当前入口拒绝 pending/dirty/stalled，尚不能接手执行一半的失败运行。它也不证明整站、函数、数据库恢复、CDN purge 或旧浏览器缓存已验收。
