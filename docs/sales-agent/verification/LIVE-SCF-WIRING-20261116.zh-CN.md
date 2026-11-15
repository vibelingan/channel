# 2026-11-16 官网询盘到 Sales：修复与验收记录

## 独立 Sales 函数的固定版本打包与代码发布清单

Claude 在 [PR #91](https://github.com/vibelingan/channel/pull/91) 指出：`sales-integration` 的线上程序来自本分支，但不在普通官网的三个函数发布清单里，接手者缺少可重复的交付步骤。本节补齐独立入口，**不把它加入普通 `FUNCTION_NAMES`，不合并到 `test`，不触发官网发布**。下面较早的验收段保留当时事实；Hermes 实例和客户群的最新状态以 Hermes PR #2 的 `IMPLEMENTATION.md` 顶部为准。

### 1. 只打已提交的版本

在仓库根目录运行，`--sha` 必须替换为本次审查及 CI 已通过的完整 40 位提交号；输出目录的上级须已存在，目标目录不得存在：

```sh
node scripts/package-sales-integration.mjs \
  --sha FULL_40_CHARACTER_COMMIT_SHA \
  --output /absolute/private/path/new-sales-release
```

脚本先核对该提交存在，再用 `git archive` 提取该提交内的函数、公共包、工作区配置和锁文件。构建在一次性临时目录运行，原工作树里的未提交文件、`.env`、浏览器状态和当前进程的云凭据变量不会复制进去。pnpm 版本必须匹配该提交的 `packageManager`；默认建议使用 CI 同款 Node 22.13.0，清单如实记录实际构建 Node 和 pnpm 版本。

它实际依次执行现有 `fn-sales-integration` 的依赖安装（冻结锁文件）、`build`、`package:artifact`、`check:artifact`。最后一项已有裸目录加载检查，不能跳过。脚本只允许 `index.js`、`reconcile.js`、`scf_bootstrap`、`package.json` 四个普通文件进入包；符号链接、额外文件、已存在的输出目录均拒绝。不会把未提交工作冒称为给定 SHA。

输出包括 `package/`、`sales-integration-完整SHA.zip` 和 `manifest.json`。清单有源码提交号、HTTP/Nodejs20.19/9000 运行要求、ZIP 大小和 SHA256，以及四个文件各自的大小和 SHA256。它固定源码并记录实际产物，不承诺不同 Node/操作系统的构建逐字节相同；包不能代替源码审查，也不是源码里的密钥检测器。

本轮已用已提交的 `af124ebcdefafd2fccae1d687107a3908e56b638` 实际隔离打包成功，运行了上述三项构建／检查；此时安全日志修复仍未提交，因而没有被错误打进这个 SHA。首次验证使用 Node v25.6.1、pnpm 11.5.0，ZIP 为 787960 字节，SHA256 `a88688f88cd5187ee539e66a960aa6567c64b921a979128b278b5aace2363ad8`。这是打包验证，**没有因此更新线上函数**。打包器四项测试还验证了脏工作树隔离、短 SHA／分支名／覆盖拒绝、额外 `.env` 和 pnpm 版本拒绝、提交中符号链接拒绝。

### 2. 发布前备份现用程序和配置

由接手技术人员通过现有 CloudBase MCP 做以下步骤，脚本本身不调用云。已读取本机 CloudBase、Cloud Functions、CloudBase engineering 技能和项目 SDK 合同规则，并核对当前 MCP 的操作 schema；本节没有新造 SDK 接口，也没有改运行权限。

1. `auth(action="status")`，确认现用账号仍仅绑定预期环境 `diversity-123-d9grnqfux221323bb`，地域 `ap-shanghai`。不匹配就停止，不能依赖上次选中的环境。
2. `queryFunctions(action="getFunctionDetail", functionName="sales-integration", qualifier="$LATEST")`，确认是既有 HTTP 函数、Nodejs20.19、9000 端口，并记录当前角色、资源限制、CAM Function URL 和触发器身份。需要完整环境变量备份时仅存仓库外私有文件（目录 0700、文件 0600），不打印或提交其值。
3. `queryFunctions(action="getFunctionDownloadUrl", functionName="sales-integration", qualifier="$LATEST")`，下载工具返回的现用程序地址，保存旧 ZIP、各文件摘要和上述配置。下载地址本身也不写进公开日志；不要自行拼接 COS 地址。旧包及完整配置未能取得时停止发布。
4. 核对待发 `manifest.json` 的完整提交号、ZIP 摘要、四个文件摘要，并确认对应 CI、审查和本次发布授权。包的提交号来自固定快照，不以工作树当前 HEAD 或文件名代替。

### 3. 只更新这一个函数的程序

当前 MCP schema 支持以下代码更新请求；`zipFile` 使用上一节通过校验的真实绝对路径，`functionName` 固定为 `sales-integration`：

```json
{
  "action": "updateFunctionCode",
  "functionName": "sales-integration",
  "zipFile": "/absolute/private/path/new-sales-release/sales-integration-FULL_SHA.zip",
  "confirm": true
}
```

使用 `manageFunctions` 执行这一请求；**不调用 `updateFunctionConfig`**，不新增／重建函数、路由、角色或凭据。HTTP 运行类型、原生 CAM 地址和全部现用环境变量保留。若工具拒绝参数、权限或包，不临时改成公开入口，也不顺带走普通 Deploy Test；记录错误并停止这次发布。

更新后用 `queryFunctions(action="getFunctionDetail", functionName="sales-integration", qualifier="$LATEST")` 有界等待实际 Active；遇到明确权限／凭据错误立即停止，不靠重复轮询解决。再次取得下载地址，下载真正运行的代码包，核对四个文件 SHA256 与清单一致。云平台可能重新打 ZIP 元数据，因此以文件摘要核对内容，不把整个下载 ZIP 摘要必须相同当作条件。配置与备份逐项比较：环境变量、角色、运行类型、运行时、端口、资源限制和入口／触发器身份应一致；代码大小、更新时间等发布元数据允许变化。

不要直接调用现有 `confirmFunctionCode` 当作 Sales 验收：它要求普通函数的 `/health` 和 releaseId 响应，本 Sales HTTP 服务没有这一合同。

### 4. 发布后验业务，恢复只退程序

先用 Hermes 现有专用调用身份读取一条获授权询盘或产品，核对来源和实际数据库读回；缺少／错误云签名应被平台拒绝，正确签名但错误业务凭据应被程序拒绝。验证伪造 `x-scf-*` 头时，必须比较同一条确实访问数据库的合法只读请求，不能用空请求的 400 或错误业务凭据的 401 证明运行头可信。

本函数程序更新稳定后，再按本轮授权做必要的真实官网询盘到未发送草稿验证。若以后合并 PR #91 导致普通 `admin/public-api` 首次按 GitHub 配置重写，必须分别从 OEM 表单及产品询价各新提交一条明确标注的测试记录，检查来源捕获、Sales 处理、Resend 未发送草稿和目标客户群通知；只查变量名存在不能代替这次验收。保持发信开关 0。

失败时只使用备份的旧代码包对同一函数执行代码更新，保留当前询盘、草稿回执和数据库；不恢复旧数据库快照、不把旧环境变量整份覆盖回去。记录恢复后文件摘要、配置保持情况及合法只读结果。若曾有超出代码的配置变化，先停下检查，不能把本代码恢复清单当作配置恢复授权。

---

本轮负责现有 Sales 业务，不接管 Claude 在 HermesInfra PR #3 的新架构实现。Hermes 的修复和完整验收结果集中回 PR #2；Channel 配套代码在原 `fix/sales-live-wiring-20261108` 分支。当前代码基于官网 `test` 的 `4a6b6c8180b194c6b2da7e8585f90eb03e1e535f`，没有改官网的其他业务分支。

## 已查明的问题

Hermes 原本到官网取询盘的地址位于 `/api/integrations/sales`，但 CloudBase 没有登记这个 Sales 路由。现有 `/api/integrations` 指向文章导入函数，因此请求返回 404。不是 Resend 拒绝，也不是账户欠费。

本轮给已有的 `sales-integration` 函数创建了腾讯云原生、开启 CAM 认证的网络地址。CAM 在这里核对调用程序是否有访问这个函数的云权限；程序内部原有的客户、来源、任务、动作和版本检查继续执行。两者通过后，才会返回这条任务允许的资料。

- 环境：`diversity-123-d9grnqfux221323bb`，上海。
- 函数版本：`$LATEST`；原生入口 TriggerId `5193211`、TriggerName `kysx4l8u8q`。
- 地址：`https://1443560658-kysx4l8u8q.ap-shanghai.tencentscf.com`。
- 实测没有签名的请求被腾讯云拒绝，HTTP 436、`http request cam error`。随后两个专用调用账号均通过云签名检查；错误业务凭据仍返回程序 401。真实 OEM 和产品询价任务已完成来源授权、请求级 SDK 查库和首稿；产品任务也真实读取了当前公开产品。
- 未改变原 `/api`、文章导入、静态网站和其他函数的路由。

## 本次代码

Hermes 与官网 AI 后台使用专用调用凭据签名。云签名使用 `Authorization`，原业务服务凭据使用 `X-Sales-Authorization`；后者仍交给原有客户／任务门禁。凭据不交给浏览器和模型。

Channel 函数从腾讯云给当前请求附加的可信运行信息中取得短期凭据，建立本次请求独立的数据库 SDK。不同请求不共用全局可变 SDK 身份。产品读取复用原已批准产品的筛选逻辑，通过请求自己的数据库连接读取，不复制整库，也不把未发布资料交给 Sales。

通用云签名和运行凭据处理位于 `packages/tencent-service-auth`；这是可供其他项目打包使用的源码模块，还不是已经发布的 npm SDK。

## 已部署和真实验收结果

- Sales 本机 138 项测试通过；新签名模块 3 项、产品端口 6 项、原公开产品读取 11 项、BFF 询盘 3 项、发布清单 35 项、专用凭据加密／失败恢复 3 项通过；Hermes 相关 48 项，47 通过、1 跳过。CloudBase SDK 检查在 Node 22.13.0 下通过；本机 Node 25 的测试输出格式曾导致检查器误判，没有为此改无关文章代码。
- Sales 构建和独立部署包加载检查通过。运行凭据测试使用 SDK 网络替身，仅是代码接线检查。
- 已备份并部署 `sales-integration` 新程序。为 Hermes 和官网 AI 后台分别创建禁止控制台登录、仅能调用这个函数 URL 的账号；生成的 Key 在现有 CI 内加密，只在仓库外解密，管理 Key 未导出。账号策略 `ChannelSalesInvokeOnly20261116` 只有此函数的 `scf:InvokeFunctionUrl` 权限。签名的主账号 UIN 与子账号 UIN 分开处理。
- 原官网长期管理 Key 被 CAM 拒绝操作角色。实际采用现有 GitHub 部署身份完成上述专用账号配置，未把管理 Key 放进 Sales 服务。
- GitHub 当前身份不能新增环境分支规则（403），未改变环境规则。只读检查采用现有允许的 `ai-cloudrun-deploy-*` 标签范围，专用 `ai-cloudrun-deploy-inspect-identity-*` 标签由独立只读作业处理，原部署作业明确跳过该标签，避免触发网站或 AI 发布。

官网 OEM 表单由 `admin` 保存，产品询价由 `public-api` 保存，两个函数均已配置 Sales 来源捕获与投递并读回。工具第一次接受了错误层级的配置参数，却没有应用环境变量；修正为顶层 `envVariables` 后再次读回确认。前两条只落网站库的测试记录保留，没有补造投递；完整闭环使用后来新提交的记录。

| 实际官网提交 | 网站记录 | 正式 Hermes 任务 | 真实 Resend V1 |
| --- | --- | --- | --- |
| OEM，CODEX acceptance 20261116 verified，Headphones／500 件 | `215affd5-0d66-4c96-8256-cf39714f1078` | #1，done，1 次处理、0 失败 | `98009d15-1488-40e7-914e-f0e619371556` |
| 产品询价，CODEX acceptance 20261116 product，500 azure／美国 | `770d9c91-b847-4611-83d9-a8f1264a877f` | #2，done，1 次处理、0 失败 | `7324fcf5-19dc-4370-ae04-52883bc63b50` |

两个草稿均在 Resend 读回 `email_id=null`；Test only 实际收到各自的收取通知、草稿通知和 PDF。产品首稿中的 USD 2.68／500–999 件／MOQ 10 来自本次读取的公开产品。正式实例 `channel-website` 运行 Hermes `6a380ea`，其四项 CI 全绿，发送开关 0，发送记录 0。没有配置网站 SMTP，网站确认邮件也未发送。

群查询已真实回复。首次引用 PDF 改稿下载、解密、存库后碰到 Hermes 的“询盘 #1”编号定位缺陷，已修复并部署。随后用户重新真正 @ 并引用 `inquiry-2-draft-v1.pdf`；确认前无改稿，协调另一会话释放前台后，本会话在实际企微输入框填入并发送真实 @确认，同一人确认才创建一条 V2 run。V2 `0b58b069-aad0-4628-8f3b-0faf95910030` 已读回未发送，正文／收件人与归档一致，三段正文保留 500 件且无新增报价。V1 查询返回 404，原档案保留；产品任务 #2 的 V1 不变。

V2 附件为本客户验收用的 `inquiry-2-draft-v1.pdf`，15449 字节，归档与已解密文件 SHA256 相同；Resend 返回的附件元数据一致。Test only 实际收到 V2 通知、15004 字节的新版正文 PDF 和该附件。V2 stage-draft 重放返回同一 ID，版本／改稿／通知数不变，发送仍为 0。新版正文 PDF 已从专属库读回并渲染目检，中英文正常，无截字；未验证手机预览，也未声称已下载 Resend 附件核对字节。

本次只发布 Sales 函数、配置现有 `admin/public-api` 来源变量与 Hermes 正式销售进程。BFF 签名代码及 GitHub 配置已准备，但 AI 聊天新版／确认询盘开关仍未启用，BFF 未重新发布，不能把普通表单成功说成聊天确认询盘也已验收。官网前端、文章函数、知识库内容和 Claude 新架构均未顺带部署。

## 范围与恢复

只配置这个 Sales 函数的入口、请求身份和它的两个调用方。先备份函数程序／配置、Hub 对应实例配置及数据库；权限或真实只读失败时不打开自动消费。恢复只回退本轮程序／配置，不用旧数据库覆盖现有询盘。禁止真实邮件发送；只在 Test only 做已授权测试。

## 表达与工具核对

本次实际核对了函数运行源码、现有公开产品读取器、SDK 3.17.2 源码、云端路由及腾讯 Function URL／运行头官方文档。项目 `.agents/skills/dev-pipeline/SKILL.md` 不存在，未宣称已执行该文件。

措辞从“官网资料接口没通”改为“官网没有登记 Sales 路由，请求落到了文章导入函数并返回 404”，补齐了调用方、实际接收程序和失败原因。
