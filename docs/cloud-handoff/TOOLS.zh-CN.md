# 工具、腾讯云登录和权限

依赖和工具能从 GitHub/npm 重装。腾讯云身份、GitHub 推送身份、桌面浏览器登录不能从本机带过去。本指南没有凭证；下一项 Blog 服务开发可以在未登录腾讯云时完成。

## 能迁移哪些工具

| 本地能力 | 云端处理 |
| --- | --- |
| Git、Node、pnpm、测试、SDK 检查 | 环境脚本重装固定版本；正常使用仓库命令 |
| CloudBase MCP | 安装 `@cloudbase/cloudbase-mcp@2.36.1`。支持原生 MCP 时注册；否则用下面 mcporter 命令调用同一个 MCP |
| GitHub 读写和 Actions 状态 | 优先云平台仓库连接；有 `gh` 时用云端自己的登录。没有 `gh` 则用已连接 GitHub 工具。不会复制本机 gh token |
| 官方文档检索 | 云端自带搜索/文档工具；可选 OpenAI Docs 远程 MCP `https://developers.openai.com/mcp`，无需搬运本机配置 |
| Playwright | 独立工具包固定 `@playwright/mcp@0.0.83`；应用测试仍沿用根 pnpm lock 的 Playwright。浏览器启动需现场确认，见环境指南 |
| Figma、Notion、其他 Apps | 当前任务不依赖，不自动安装或登录。真需要时由云端连接相应远程服务并重新授权 |
| 桌面 CUA、stealth-browser、私人笔记桥、Xcode、桌面 node_repl/Apps 私有通道 | 本机专用，不复刻，不把私人目录、管道地址或登录文件上传 |

这张表覆盖当前工作需要的能力；不承诺云端拥有本机所有工具。原生 MCP 是否加载取决于实际云端产品，不能只放一份本机 config 就称为已经可用。OpenAI 说明本地 Codex 主机支持 config.toml 注册 MCP，网页连接另有插件路径；本包因此保留命令行方案。[官方 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 先列出工具，不登录、不操作资源

安装后，在仓库根目录：

```bash
bash scripts/cloud-handoff/mcp.sh list
bash scripts/cloud-handoff/mcp.sh list cloudbase --schema --all-parameters --timeout 90000
```

`docs/cloud-handoff/mcporter.json` 只指向独立工具目录，不读取本机编辑器配置，不包含默认环境和凭证。命令行入口只转交参数，**不是写入权限的安全屏障**；MCP 同时提供读和写工具，真正权限由腾讯云 CAM / 角色及任务授权控制。工具列表成功也不等于已登录，退出码 0 但显示 unavailable / timeout 仍算未通过。

若宿主支持原生 stdio MCP，可在其设置中登记命令 `tools/cloud-handoff/node_modules/.bin/cloudbase-mcp`，用该 checkout 的实际绝对路径，不写回仓库。若使用 Codex CLI，`codex mcp add cloudbase -- <实际绝对路径>`；随后新会话读回工具表。本包不会自动覆盖 `~/.codex/config.toml`。 首次冷启动可能超过 30 秒，支持该字段的 Codex 主机可设置 `startup_timeout_sec = 120`，并在新会话确认工具确实已加载；不要重复安装来处理正常冷启动。

支持远程 MCP/OAuth 的宿主也可连接国内官方地址 `https://tcb-api.cloud.tencent.com/mcp/v1`，由宿主完成浏览器授权；远程服务不固定到 npm 的版本，需重新读实际 schema。远程模式缺少部分本地文件上传/下载能力，不能无条件替代已实现的本地文件发布适配器。[CloudBase 源码中的接入说明](https://github.com/tencentcloudbase/CloudBase-MCP/blob/5a1c4275c3ac7c6253548428c362fb2c1c834aff/config/source/skills/cloudbase-mcp/SKILL.md)。

需要命令行 Playwright MCP 时，在支持 stdio 的宿主登记 `tools/cloud-handoff/node_modules/.bin/playwright-mcp --headless --isolated` 的实际绝对路径。`--isolated` 使用独立临时浏览器状态，不导入私人 Chrome 登录；只允许任务需要的目标。宿主不提供原生浏览器工具时，先用仓库的 Playwright CLI 测试，不将安装成功当作浏览器已经可用。

## 云端重新登录 CloudBase

下面操作由云端 agent 在**确需读取云端资源且得到相应授权以后**执行；交接安装和当前 Blog 离线开发不自动执行。先查看上一步实际 auth schema，参数和版本不一致就按已安装工具核对，别照旧文档猜。

```bash
bash scripts/cloud-handoff/mcp.sh call cloudbase.auth action=status --output json
# 确认未登录以后，启动设备授权，让用户在自己的浏览器完成：
bash scripts/cloud-handoff/mcp.sh call cloudbase.auth action=start_auth authMode=device --output json
# 用户授权完，重新检查：
bash scripts/cloud-handoff/mcp.sh call cloudbase.auth action=status --output json
```

设备码和链接可以展示给当前用户，但不写入 GitHub。用户自行完成密码和二次验证；不让用户在聊天里发密码。登录状态和凭证只留在该云端实例的私人目录，不打包成产物，不尝试从本机同步。

已知生产目标来自原 GitHub `test` environment 的 `TCB_ENV_ID` 变量和既有发布配置。有已授权的 `gh` 且需读取时，可用下面命令获取非密钥的目标编号；没有变量读取权限则由环境管理员通过云端私人配置提供该编号，不能新建一个目标代替：

```bash
TCB_ENV_ID="$(gh api repos/vibelingan/channel/environments/test/variables/TCB_ENV_ID --jq .value)"
export TCB_ENV_ID
```

别按名字猜新建环境，别复制历史设备码。需读取时先对照现有目标的完整 EnvId、国内站和地域；本次默认国内站，既有目标按实际配置核对，不能因为“海外部署”讨论就改国际站。设置默认环境只改变当前工具绑定，不创建云资源：

```bash
# 先由已授权的仓库连接取得准确配置，不提供一个随便填的默认值。
: "${TCB_ENV_ID:?Set the verified existing target EnvId first}"
bash scripts/cloud-handoff/mcp.sh call cloudbase.auth action=set_env envId="$TCB_ENV_ID" --output json
```

`TCB_ENV_ID` 是现有脚本变量；MCP 读取进程环境时叫 `CLOUDBASE_ENV_ID`，不要混用。授权后如需只读确认，查询工具的明确 action 和返回 fields；不导出整份函数环境变量、业务数据或登录态。

### 不适合浏览器登录时

可由管理员在云环境的私人配置中提供短期、受限的腾讯云身份。已核对 MCP `auth.ts` 支持这些进程环境变量：

| 变量 | 含义 |
| --- | --- |
| `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` | 管理 SDK 的腾讯云身份，必须能用于请求签名 |
| `TENCENTCLOUD_SESSIONTOKEN` | 使用 STS 临时身份时必需；过期后重新授权 |
| `CLOUDBASE_ENV_ID` | 经核对的目标环境 |
| `TCB_SITE`、`TCB_REGION` | 仅本地运行的 MCP 使用；不得覆盖现有目标的站点/地域 |

不创建含密钥的 json、.env、命令行参数、日志或 GitHub 文件。不要开 `set -x`，不打印完整 env。应用 JWT、管理员密码和数据库口令不属于管理 MCP 登录材料。

新版云端的 Network secret 给程序的是占位值，真实值在 HTTPS 代理替换。腾讯云 SDK 在本地用 SecretKey 算签名，需要真实可读值，因此**不能直接把 SecretKey 当成 Network secret 的占位值交给 SDK**。优先设备授权；否则仅在所选云产品明确允许的私人直接变量机制里配置短期值。旧版 Secrets 只在 setup 期存在，进入 agent 阶段会移除；不要为绕过这一点把它落盘持久化。若宿主不提供合适机制，管理操作保留在已有 GitHub Actions 受控入口，云端继续离线开发。[新版凭证机制](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)、[旧版 Secrets](https://learn.chatgpt.com/docs/environments/cloud-environment#environment-variables-and-secrets)、[CloudBase 身份源码](https://github.com/tencentcloudbase/CloudBase-MCP/blob/5a1c4275c3ac7c6253548428c362fb2c1c834aff/mcp/src/auth.ts)。

## 权限按当前任务开，不给整个账号管理员

| 任务 | 需要的身份/范围 | 本次是否需要 |
| --- | --- | --- |
| 编写草稿服务、跑本地测试 | GitHub 仓库读取；推送仅原 SEO 分支 | 需要 |
| 查看目标配置、函数版本和站点状态 | 经管理员核对的 CloudBase/SCF/COS 对应只读操作，限目标环境；不授予 Invoke、写数据或更新配置 | 当前不是前置 |
| 真实假业务演练 | 独立、短期授权，只允许计划中 dummy 函数、专用集合和 canary 路径；保留普通业务的拒绝写入 | 等现场窗口和明确授权 |
| 正式发布/恢复 | 已有 GitHub Actions、环境权限、共享部署锁、版本检查和恢复证据；不能用个人 MCP 绕过 | 关闭 |
| 授予权限、修改角色、购买、删业务资源 | 管理员另行操作，不包含在开发身份中 | 不授权 |

CAM 的具体 action/resource 支持粒度随接口而异。管理员应依照实际调用和目标资源生成策略、读回并验证，不能把“只读”理解成整个环境数据都可导出。本包不附一个未经现场验证、可能放宽到 `*` 的假最小权限 JSON，也不自动给子账号挂全权限策略。[CloudBase 权限说明](https://cloud.tencent.cn/document/product/876/47055)、[SCF 权限说明](https://cloud.tencent.cn/document/product/583/47932)。

假业务函数的运行身份还要单独核对：管理账号能部署函数，不代表函数只能写 dummy 集合。不得把当前生产函数运行身份当作隔离证明。未通过这个检查不开始真实云端测试。具体范围/清理都按 `docs/seo/execution/LIVE-RESUME-AND-CLEANUP.zh-CN.md`。

## 网络故障怎么排查

下载阶段先查 npm/GitHub 访问；列工具阶段先区分 MCP 进程没启动、schema 超时和缺 Node 运行时；登录再查设备授权；资源读取才查 CAM、目标和地域。错误不能统一写成“权限不够”。腾讯云使用 POST 读取 API 时需网络策略允许 POST；只读身份才负责限制写操作。先按失败请求确认需要的端点，例如 `tcb-api.cloud.tencent.com`、`tcb.tencentcloudapi.com`、`scf.tencentcloudapi.com`；COS 地址从现有目标读回后精确允许，不能放行整个云域名来碰运气。

## GitHub 权限与 CI

云端账号和本机账号可以不同，但必须有本仓库访问权。不要把本机 gh 多账号状态当成云端登录。无需为了下一项服务开发取得仓库环境管理员权限；该权限仅在确需改环境配置时另行授权。

有已授权 `gh` 时，完成提交/推送后可读回：

```bash
gh run list --repo vibelingan/channel --branch feat/seo-foundation \
  --workflow seo-module-1.yml --limit 5 --json databaseId,headSha,status,conclusion,url
```

找到本次提交对应 run，再用 `gh run view <run-id> --repo vibelingan/channel --json headSha,status,conclusion,jobs,url`。不要执行 `workflow run` 来验证有线上写入的入口。旧验证日志已随仓库保留，不能用于证明新提交通过。
