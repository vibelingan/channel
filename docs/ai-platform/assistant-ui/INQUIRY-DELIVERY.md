# 官网助手确认询盘：前后端交付

2026-10-31。沿用 MIU 8a／6d，复用现有核对组件和 SG1.2 保存。代码与本地联调已完成；默认关闭，尚未部署，不发送真实邮件。

## 客户现在能走通什么

客户可以从助手或产品卡片打开原询盘核对表单，补全需求、邮箱和本次联系同意。点击确认后，BFF 验证会话，调用固定的 Channel 内部接口。Channel 在原事务中一起保存 OEM 询盘、来源登记和待派发记录，再返回原询盘回执。无需销售下指令；既有派发器运行后才交给 Hermes。本轮没有启动线上派发。

前端复用 `InquiryReview`、`useAssistantSession` 和原状态机；这次补的是实际 adapter 与后端保存，不是重写聊天界面。不同入口的业务事实统一保存，产品卡片只传公开 ID，服务器重新读取当前公开名称、版本和读取时间，后续报价仍需实时读取。产品下架仍可记录需求，并明确当时不可用。

## 重试与权限怎样处理

- 浏览器冻结原表单、提交 key 和原会话身份。保存成功后网络断开，显示结果未知；点击核对原提交，返回同一条记录。凭据失效也不能偷偷换会话重建。匿名跨设备／清缓存找回仍暂缓。
- BFF 验证会话凭据、表单长度、邮箱、本次联系同意及版本。Channel 另验专用服务凭据、当前安装归属和有效状态；客户／环境／安装不由模型或浏览器提供。
- 相同 key 改内容返回冲突；并发提交只有一个结果。询盘、来源或派发记录中任何一步失败，事务一起回滚。
- BFF 与浏览器分别核对回执的会话和提交身份，错误回执不能显示成功。联系方式不加入模型消息或默认上下文。

此处同意的是销售联系本次需求，不等于营销订阅授权。保存接口没有邮件动作。

## 本地检查和发现

| 检查 | 实际结果与范围 |
| --- | --- |
| Channel DB、admin、public-api、sales-integration 关联回归 | 708 项通过；本地事务替身，不是线上云库 |
| 新保存／HTTP／后台需求展示 | 8 项针对性通过，包含并发、撤权、完整需求、回滚和 HTML 转义 |
| 真实浏览器联调 | 24 项通过，桌面与手机尺寸；包括实际保存、丢回执恢复、每类仅一条记录、产品引用及既有聊天回归 |
| 定向缺陷注入 | 网页／BFF 共 13 处（新增 5 处），Channel 保存 4 处均被断言抓到；故意删除保护后测试必须失败 |

先后按业务／权限／事务和测试有效性两轮自查。修正了并发改稿同 key 的冲突回执、凭据过期重复建单风险，以及测试进程误认旧服务的风险。后台原编辑窗口增加完整只读需求，避免只看到 Other 分类。初次浏览器测试还沿用“询盘未启用”和旧邮箱标签断言，已对照真实 DOM 修正。

浏览器连接的是实际 React 组件、BFF、PostgreSQL、Channel HTTP 接口和正式保存／来源代码。CloudBase 事务由支持回滚、文件持久化的本地替身承担；模型和产品为明确标注的样例。真实云库、真实模型、生产目录、Hermes 派发与 Resend 尚未在本轮联调。没有把这些测试称为线上验收。

CloudBase 事务 API 已对照官方文档和安装的 SDK 源码，SDK 合同检查通过；函数构建、独立打包和冷加载通过。网站测试 1,497 项通过、1 项跳过；运行层回归 90 项通过。网站 typecheck 为 0 error，Astro 构建及渲染 SEO 检查通过；开发预览未进入构建。Sales `68bab602` 的 [远端 CI](https://github.com/vibelingan/channel/actions/runs/41079101819) 通过，UI 代码提交 `cfa445e55dc84ee8cde2bea7281f86bdc4956f95` 的 [聊天联调 CI](https://github.com/vibelingan/channel/actions/runs/41080160394) 通过；同一提交的 [组件状态 CI](https://github.com/vibelingan/channel/actions/runs/41080160693) 也通过。

附加运行包检查发现 worker 将 workspace 的 TypeScript 合同留作外部依赖，普通 Node 22 冷加载会报 `ERR_UNKNOWN_FILE_EXTENSION`。已按 BFF 现有规则把 `ai-contracts` 一并打入 worker，修正后，BFF 和 worker 各自的独立生产依赖包在普通 Node 22 中均冷加载成功。完整仓库 Dockerfile 的首次构建在 npm 下载阶段失败，该构建尚未通过。另将真实生产依赖包放进最小 Linux Node 22 镜像，BFF 和 worker 均冷加载成功。最初测试复制依赖时未保留相对符号链接，导致测试镜像找不到 pg；修正测试复制方式后才计为通过。这证明 Linux 运行包可导入，不代表已经验证完整构建或部署。

## 两条分支怎么接

UI 分支 `feat/website-assistant-ui-foundation` 接共享合同、BFF 和原组件 adapter，并补齐 worker 的合同打包配置。Sales 分支 `feat/sales-agent-integration` 提供原保存事务的内部接口；没有整合 pricing、SEO 或其他分支。共享合同先独立提交，随后复用到两边。浏览器 CI 固定读取 Sales `68bab6024488f58a29dd7d0eb0ceaeed103290c9`，不追随浮动分支。

可重跑：

```sh
# 先启动隔离的本地 PostgreSQL，不能使用生产地址
export DATABASE_URL=postgres://chat_test@127.0.0.1:62381/postgres
export CHAT_TEST_DATABASE_URL=postgres://chat_test@127.0.0.1:62381/chat_browser
export ASSISTANT_SALES_SOURCE_ROOT=/Volumes/Lexar-Mac/Projects/channel-sales-agent-integration
node scripts/verify-chat-slice-guards.mjs
pnpm exec playwright test --config playwright.assistant-chat.config.ts
```

默认关闭。BFF 需 `AI_INQUIRY_ENABLED=1`、固定 HTTPS 根地址 `AI_INQUIRY_BASE_URL` 和专用 `AI_INQUIRY_TOKEN`；官网需 `PUBLIC_AI_INQUIRIES=1`。Channel 配置及真实环境验收见 Sales 分支 `docs/sales-agent/ASSISTANT-INQUIRY-DELIVERY.md`。

## 还没做什么

本次保存与知识检索无依赖。SSH 审计已确认 Hermes 使用的 VibeKB MCP 检索和旧 AnythingLLM 兼容 HTTP 服务不是同一路径。现有旧 adapter 没有因此变成新 MCP 连接；公开知识检索仍需单独按固定公开范围接线和验收。没有改远端配置或启用内部知识访问。

下一次先做专用测试环境的真实云库保存／去重／回读，再验原派发器到 Hermes；继续遵守不发真实邮件。当前无需客户补充新的业务决定。

文字复核实际读取本报告、INQUIRY-PLAN、README、BACKEND-MIUS、MIU-PLAN 与代码。把“询盘保存就启动 Agent”改成“保存待派发记录，原派发器运行后受理”；核对了同事务写入、当前产品读取、没有邮件调用和匿名凭据寿命。
