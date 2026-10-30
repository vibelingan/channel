# 官网智能客服确认询盘：保存接线

2026-10-31。沿用 MIU 8a／6d 和 SG1.2；原 OEM、单品表单和既有派发器继续复用。本轮不发真实邮件、不部署、不改 Hermes 或 VibeKB 配置。

## 现在做了什么

客户在官网助手核对需求、邮箱和本次联系同意后，BFF 验证当前会话，再用独立服务凭据调用 Channel 内部 `assistant-inquiries` 接口。接口不接收客户、环境或安装身份；它们来自当前服务配置和安装登记。

保存复用 `saveFinalizedOemInCloud()`：原 `oemProjects` 记录、SG1.2 来源登记和 pending delivery 在同一事务写入。待派发记录由原派发器处理；本轮没有启动线上派发或 Hermes 自动任务。

助手需求保存在原询盘记录的 `assistantSubmission`，支持 4,000 字符。原 Category 使用合法的 Other；后台原编辑窗口额外显示完整只读需求。内部 Sales 资料读取和事件摘要保留完整需求。助手产品引用只保存服务器当前读取的公开产品 ID、名称、版本、读取时间，不把历史卡片当报价。产品已下架时仍记录客户询盘，并明确查询时不可用；暂时查询失败不伪造产品资料。

**来源兼容边界：**业务事件沿用现有 `website_oem`，资料中 `inquiry_entry=assistant` 标出助手入口；没有声称 Hermes 已支持新的 `website_assistant` 合同类型。它进入同一销售业务流程，不是单品选项／价格的正式报价单。

## 回执丢失与权限

项目 ID 由服务器安装身份、会话和稳定提交 key 决定。完整确认表单另存 SHA-256 指纹。相同提交只返回原回执；同 key 改内容返回 409；并发也只有一个结果。恢复原结果时先检查当前安装，再读取原记录，不依赖当前产品服务仍在线。

BFF 与浏览器分别检查回执中的会话和提交身份。即使聊天凭据过期，核对原询盘也不会换成新会话重新提交。浏览器关闭／清缓存后不提供匿名跨设备找回；这是暂缓的历史恢复范围，不能假装已经解决。表单联系方式没有写入模型消息、默认模型上下文或日志。

## 验证与复核

本地完整关联回归 708 项通过；后台需求展示另有 1 项服务端渲染测试通过。网页浏览器联调在 UI 分支独立记录，不把它算成真实云库验证。

- 本地新保存测试：普通需求、4,000 字符边界、产品引用、16 次并发相同提交、并发不同内容共用 key、撤权、跨安装、写完询盘／来源后最后一步失败回滚、原结果恢复。
- HTTP 验证：专用凭据、重复认证头、缺同意、额外身份字段被拒绝；上游回执身份不符不能显示成功。
- 两轮自查分别检查业务／权限／事务边界和测试是否命中实际代码。修正了并发内容冲突统一返回 409、过期身份不能重建询盘、测试服务必须核对本次启动身份；初次浏览器断言仍假设旧版没有询盘按钮、邮箱标签未包含星号，已对照实际 DOM 修正，不改变业务以迁就测试。
- 复用了 CloudBase skill／函数参考，查询官方事务文档并核对安装的 node-sdk 3.17.2／database 1.4.3 源码；没有 Context7 工具。实际事务 API、冲突重试、文档 set/get 的形状与现有 SDK 门禁一致，`verify-cloudbase-sdk` 通过。
- 4 处后端缺陷注入被行为测试抓到，记录在 `evidence/assistant-inquiry-defects.json`；网页另有 5 处新增缺陷注入，复用原 8 处回归。

**本地替身边界：**端到端使用真实组件、BFF、PostgreSQL、内部 HTTP 处理器及正式保存／来源代码；CloudBase 事务后端用带回滚和文件留档的本地替身。模型、产品和联系人均为测试样例。它证明本地程序流程，不证明真实云库、真实模型或生产连通。

官方事务参考：[CloudBase 事务操作](https://docs.cloudbase.net/database/transaction)。源码路径：`packages/db/src/assistant-inquiry.ts`、`sales-inquiry-submission.ts`、`sales-inquiry-source.ts`、`apps/functions/sales-integration/src/assistant-intake.ts`、`index.ts`。

## 提交和远端检查

Channel 保存端代码 `68bab6024488f58a29dd7d0eb0ceaeed103290c9` 已推送 `feat/sales-agent-integration`，[Sales CI](https://github.com/vibelingan/channel/actions/runs/41079101819) 通过。UI／BFF 接线代码 `cfa445e55dc84ee8cde2bea7281f86bdc4956f95` 已推送 `feat/website-assistant-ui-foundation`，[聊天联调](https://github.com/vibelingan/channel/actions/runs/41080160394) 和 [组件状态](https://github.com/vibelingan/channel/actions/runs/41080160693) CI 均通过。随后仅补交付文档，没有新增运行变更。

网页本地 24 项浏览器联调、运行层 90 项、站点 1,497 项（另跳过 1 项）通过；Astro 构建通过。运行包检查发现 worker 漏打包合同，已在 UI 分支修正，BFF／worker 独立 Node 22 和最小 Linux 容器均冷加载通过。完整 Dockerfile 构建在依赖下载阶段失败，该完整构建仍未通过；不把最小容器验证称为完整镜像或线上验收。

## 配置与下一步

默认关闭。正式接入需要：Channel 同时开启 `SALES_INTEGRATION_ENABLED`、`SALES_SOURCE_CAPTURE_ENABLED`、`SALES_ASSISTANT_INTAKE_ENABLED`；设置不同于 source-grant／Hermes 凭据的 `SALES_ASSISTANT_INTAKE_TOKEN`；沿用当前客户、安装、环境和 cutover 配置。涉及产品的提交还需批准目录读取开关。原安装必须已经登记 active；不新建业务集合。

BFF 开启 `AI_INQUIRY_ENABLED=1`，设置固定 HTTPS 根地址 `AI_INQUIRY_BASE_URL` 和匹配的 `AI_INQUIRY_TOKEN`。官网在原 v2 助手开关外用 `PUBLIC_AI_INQUIRIES=1` 显示入口。只配置 key 不会自动部署或发送邮件。

上线前还要在专用测试环境完成真实 CloudBase 保存／去重／回读、原派发器到 Hermes 的交接验收；VibeKB 需要另接固定公开范围的 MCP 检索，当前旧 AnythingLLM 路径不能当作已完成。没有需要客户现在解决的新业务决策或账号问题。

文字复核读取本报告、执行计划和实际实现。将“保存成功就已启动销售 Agent”修正为“原子记录待派发，既有派发器运行后受理”，核对了写入顺序、事件类型和未发邮件的调用边界。
