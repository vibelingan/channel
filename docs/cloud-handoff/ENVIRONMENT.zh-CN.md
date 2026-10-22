# 云端环境怎么配

仓库选择 `vibelingan/channel`，任务源分支选择 `feat/seo-foundation`。先做无云凭证的开发环境，足以继续下一项后台草稿服务。环境发布是保存开发配置，不是把网站部署到腾讯云。

## 新版环境与旧版设置

OpenAI 目前同时说明了新版云端环境和旧版 Codex Cloud。新版有 Install script 和检查配置；旧版有 Setup script / Maintenance script。两者都使用下面仓库内脚本，但不要把旧版 Secrets 的行为套到新版。源码和规则可以经 GitHub 传递，本机登录和私人 skills 不会自动同步。[新版说明](https://learn.chatgpt.com/docs/environments/cloud-environments)、[旧版说明](https://learn.chatgpt.com/docs/environments/cloud-environment)。

在环境设置里固定 Node **22.13.0**，需要 Python **3.11 或以上**、Git、npm。pnpm **11.5.0** 由本交接工具安装，和仓库 packageManager / 既有离线 CI 一致。云函数运行时与开发环境不是同一件事；已有打包验收另用 Node 20.19.0，不要改函数 runtime。

Install / Setup script：

```bash
bash scripts/cloud-handoff/setup.sh
```

该脚本只做四件事：校验 Node；按独立 npm lock 安装工具；按根 pnpm lock 安装项目依赖且不运行生命周期脚本；从 GitHub 的固定提交下载 11 个技能并核对 SHA-256。不会登录、调用腾讯云业务 API、创建集合、部署、改分支或触发恢复。

旧版环境可能先在默认分支运行 setup，而文件只在 SEO 分支。此时 setup 字段可用以下兼容写法；Maintenance 字段仍使用下面的严格脚本。兼容写法只允许默认 main 暂缓，其他错误分支立即失败：

```bash
if [ -f scripts/cloud-handoff/setup.sh ]; then
  bash scripts/cloud-handoff/setup.sh
elif [ "$(git branch --show-current)" = main ]; then
  echo 'Handoff lives on feat/seo-foundation; maintenance must install it before work.'
else
  echo 'Select feat/seo-foundation before setup.' >&2
  exit 1
fi
```

Maintenance / 更新缓存后，在已经检出 SEO 分支的任务中运行：

```bash
bash scripts/cloud-handoff/setup.sh
```

第一次安装先选正确分支，安装后再启动新任务，让技能能在任务初始化时被发现；已有任务没有重新扫描技能时，可直接读 `.agents/skills/<名称>/SKILL.md`，不要假称已经自动加载。技能安装遇到不同内容的同名目录会停止，不覆盖。先检查差异；本次不要求抹掉云环境已有技能。

## 检查和开发命令

下面脚本自动使用仓库内固定版本 pnpm，不依赖 setup 进程临时设置的 PATH：

```bash
bash scripts/cloud-handoff/check.sh
# 另跑全量回归：
bash scripts/cloud-handoff/check.sh --full
```

它检查当前代码继承本次交接基点，拒绝其他业务分支；允许以正确提交处于 detached HEAD。若平台自动使用别的临时分支，先在平台选择原 SEO 源分支并核对实际 SHA，不擅自新建/覆盖远端分支。

手动执行其他项目命令时，每个新 shell 都先设置：

```bash
export PATH="$PWD/tools/cloud-handoff/node_modules/.bin:$PATH"
pnpm --filter @vibelingan-channel/articles test
pnpm --filter @vibelingan-channel/articles typecheck
pnpm verify:cloudbase-sdk
pnpm lint
pnpm test
```

需要修改公开 HTML 时，沿用已有 CI 的假商品数据构建，不调用生产商品 API：

```bash
export PATH="$PWD/tools/cloud-handoff/node_modules/.bin:$PATH"
fixture="$(mktemp -t channel-product-seo.XXXXXX)"
pnpm --filter @vibelingan-channel/site seo:fixture "$fixture"
SEO_CATALOG_SNAPSHOT="$fixture" pnpm build
rm -f "$fixture"
```

这是仅供本地的 fixture，默认 localhost canonical；不能把生成的 dist 上传网站。要部署时必须重新读取正式发布指南，给正确 SITE_URL、真实快照及所有发布前检查。应急跳过 SSG 和自动内容更新还有未实现项，不得凭参数名猜测可用。

## 网络与权限

安装期需要 HTTPS：`registry.npmjs.org`、`registry.npmjs.com`（如实际 registry 使用）、`codeload.github.com`、`github.com`、`raw.githubusercontent.com`、`api.github.com`。GitHub 连接授权读取本仓库，推送时只准原 SEO 分支。`git fetch` 若用 SSH 受阻，用云平台 GitHub 连接或已授权的 HTTPS；不要上传本机 SSH 私钥。

继续离线开发时，不需要腾讯云密钥、后台 JWT、会员账号、数据库口令、WeCom webhook 或 Hermes 凭证。需要官方在线文档时再允许对应 OpenAI / CloudBase 文档域名；需要腾讯云管理时按[工具指南](TOOLS.zh-CN.md)开放真实端点。腾讯云部分只读调用也使用 POST，所以仅允许 GET 的网络政策无法完成 SDK 读取。网络放行不等于允许资源写入。

2026-10-22 已在当前云实例验证 Node、固定版本 pnpm、依赖安装、技能、离线 MCP 列举、浏览器启动及本地检查，详情见 SESSION.zh-CN.md。换到新实例仍应记录 Node、pnpm、SHA、技能是否安装、MCP 是否可列出、是否实际登录，以及哪些测试未运行；当前实例通过不能代替真实 CloudBase 验收。

## 浏览器和本机工具

OpenAI 新版云端指南当前把内置电脑/浏览器操作列为未支持。本包不复制本机 Chrome、stealth-browser、桌面 CUA、Xcode、私人笔记桥接或桌面 Apps 登录。[限制说明](https://learn.chatgpt.com/docs/environments/cloud-environments#current-limitations)。

仓库 Playwright 测试和 `@playwright/mcp` 是可以安装的命令行程序，能否启动 Chromium 要在所选容器验证，不能据此声称拥有桌面浏览器能力。界面开发确需截图时，在允许安装系统依赖的环境运行：

```bash
export PATH="$PWD/tools/cloud-handoff/node_modules/.bin:$PATH"
pnpm exec playwright install --with-deps chromium
```

若容器限制浏览器运行，继续模块服务层测试，明确留下浏览器验收缺口；不要连接用户私人浏览器来绕过限制。当前 BLOG-D1 无 UI 改动要求，不需浏览器才能开始。
