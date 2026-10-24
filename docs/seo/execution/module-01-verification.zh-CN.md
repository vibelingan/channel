# 模块 01 验证记录

记录时间：2026-10-20。本记录针对 `feat/seo-foundation`，模块实施前 HEAD `259fb689e77ee9a02843585bf6d72cbdbbe56d1e`，本轮 fetch 的主线 `37bcea5b38284210159e95f8d10f3a9b5cf2ee44`。继续原分支；没有创建新 worktree、PR 或其他任务。

## 验收边界

A1/A2 可以单独验证并推送：输入文件/来源合同、恢复计划身份和严格执行回执均有本地测试。`.github/workflows/seo-module-1.yml` 在本分支 push 后运行相同脚本回归及全仓 lint，只保留 GitHub 日志。

它不绑定 `test` environment，没有 CloudBase 凭证、OIDC 或部署调用；四条既有 workflow 与本模块开始前保持字节一致。正常部署依旧只由原有入口控制。分支 push 不匹配 Deploy Test 的 `test` 分支，也不匹配 AI CloudRun 的部署 tag；没有 dispatch 原部署或 E2E 工作流。

B/C/D 尚未交付，故没有现场云恢复、CDN/浏览器缓存验收、数据库恢复或自动恢复演练。B2 尚未提供线上当前发布证明，商品恢复保持未启用。GitHub 来源 metadata 和 seal 在本地测试里是明确标记的 fixture，不能作为真实平台授权。

## 已执行的检查

Node 固定 `22.13.0`，pnpm 固定 `11.5.0`。为避开原 checkout 中文件按需下载造成的读取阻塞，在 `/private/tmp/channel-seo-module1-20261020/source` 导出了同一提交的源码，安装 frozen lockfile，覆盖本模块改动进行验证。它是临时源码副本，没有创建 Git worktree；Git 清单检查只读原仓库 metadata。

| 检查 | 命令或方法 | 结果 |
| --- | --- | --- |
| 定向用例 | `node --test scripts/hosting-recovery.test.mjs scripts/release-artifact.test.mjs scripts/release-envelope.test.mjs scripts/recovery-kernel.test.mjs scripts/release-module-ci.test.mjs` | 115 个通过 |
| 已有脚本回归与模块用例 | `pnpm test:deploy-smoke` | 562 个通过 |
| 全仓格式及 lint | `pnpm lint` | 通过 |
| 原构建链路 | `pnpm --filter @vibelingan-channel/site seo:fixture <file>`，再用该文件执行 site 包的 `build` | 18 页、10 个 indexable canonical URL，原构建 SEO gate 通过 |
| 真实构建格式接入 | 在临时目录使用已标记的合成 production-shape snapshot 再构建；对生成目录运行 seal → verify → plan | 147 文件、2 商品、实际 sitemap/manifest 全部通过；产物未上传 |
| 样式修正无行为差异 | 相对实施前 HEAD 比较 Astro 模板、frontmatter AST、import 身份及图源解析后的 JSON | 7 文件等价 |
| workflow 回归 | 解析 YAML，验证权限/触发分支/步骤和禁止部署图；包含主动注入不安全节点的反例 | 通过 |

完整 `pnpm test`、全部工作区 typecheck、Playwright 和真实数据库测试不作为本模块单独验收项；原完整 CI 的相应步骤保持原样，后续合入与发布仍须通过原门禁。这里没有把脚本回归写成整个仓库所有测试通过。

初轮扩大回归在沙箱内遇到 `listen EPERM`，源码副本的 Git 清单测试也因没有 `.git` 失败。之后允许本地 loopback 并显式提供只读 Git 路径，按相同断言重跑通过；没有跳过这些测试。首次构建同样遇到 tsx 的 IPC 限制，后续本地授权运行通过。

本地原始日志、失败测试证据、构建日志和身份收据保存在 checkout 的 `output/seo-module-01-2026-10-20/`，按仓库规则不提交。远端结论应核对交付回复里同一 commit 的 GitHub run；不能以本地结果替代远端状态。

## 测试覆盖的关键行为

- 两次清单/配置不稳定、ETag/长度/hash 不一致、multipart 缺独立证明均拒绝。
- v1 兼容；v2 来源/目标/scope/组件描述被 hash 约束；错误仓库、workflow、event、ref、run、SHA、artifact、过期或缺 seal 均拒绝。
- 商品 HTML、商品 manifest、SEO manifest、sitemap 任一单独残留撤回商品都拒绝；合法零商品、完整投影、正常 sitemap index 和自定义分片有通过用例。
- 缺分片、循环、重复、外域、非规范 URL、DTD/外部实体、错误 namespace、过深/过大的 XML、损坏/过大 JSON 均拒绝。
- 根目录/中间/最终 symlink、路径越界、目录冒充文件和超限成员不通过。
- 临时文件目录上的完整恢复实际执行上传/读回/精确移除/配置/最终身份检查。每阶段的 false、void、pending、不完整/错误 hash 或操作身份会停止。
- 同一计划以前执行的回执不能满足本次 executionId；调用方异步修改原计划也不会改变待执行操作。
- canary 只能使用配置好的前缀、保留全站配置，不能带函数、商品快照或自定义 XML 发现文件。未知角色的退役 XML 停止计划，等待明确归属证明。

## 自审修正与文字核对

实际审阅：`hosting-recovery.mjs`、`prepare-hosting-recovery.mjs`、三份 `scripts/release/` 实现、相关测试、现有四条 workflow、新增 offline workflow，以及模块页与执行索引。对照了 Deploy & CI/CD、E2E Testing 工程规则；parser 的 namespace/strictEntities/doctype API 对照安装包及维护仓库文档。

除原 R1（sitemap-only 撤回漏检）和 R7（false 验收成功）外，自审用失败测试补强了自定义分片/robots、组件描述绑定、跨执行回执重放、canary 自定义 XML 和未知退役 XML。内核只有纯校验/回调，没有引入默认在线 fallback 或自动重试。

修正了一处容易误解的表述：把“来源验证已完成”明确写成“比较受信任适配器提供的来源 metadata，本模块不认证 GitHub”。把上传结果单独命名 submitted，避免把尚未读回的写入说成 verified。核对这些表述时分别检查了 `verifyReleaseArtifact` 的实际输入，以及 `upload → verify` 的执行顺序和回执断言。

全仓 lint 发现实施前 SEO 提交的七份文件存在格式问题，只格式化两处 Astro frontmatter 和五份图源 JSON；独立 AST/JSON 比较确认值和逻辑相同。没有改正文、交互、pricing 或其他 worktree。

## 下一依赖

下一次交付是模块 02 的 B1：状态、步骤日志、环境锁、恢复目标选择。C 接入时必须把真实读回结果转换成这里的 receipt，并提供真实来源 metadata；不能照抄 expectedHash。B/C/D/F 对应范围完成后，才安排同一现有线上目标的受控 canary 恢复。
