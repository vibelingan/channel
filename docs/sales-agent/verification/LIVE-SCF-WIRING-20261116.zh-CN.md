# 2026-11-16 官网询盘到 Sales：修复与验收记录

本轮负责现有 Sales 业务，不接管 Claude 在 HermesInfra PR #3 的新架构实现。Hermes 的修复和完整验收结果集中回 PR #2；Channel 配套代码在原 `fix/sales-live-wiring-20261108` 分支。当前代码基于官网 `test` 的 `4a6b6c8180b194c6b2da7e8585f90eb03e1e535f`，没有改官网的其他业务分支。

## 已查明的问题

Hermes 原本到官网取询盘的地址位于 `/api/integrations/sales`，但 CloudBase 没有登记这个 Sales 路由。现有 `/api/integrations` 指向文章导入函数，因此请求返回 404。不是 Resend 拒绝，也不是账户欠费。

本轮给已有的 `sales-integration` 函数创建了腾讯云原生、开启 CAM 认证的网络地址。CAM 在这里核对调用程序是否有访问这个函数的云权限；程序内部原有的客户、来源、任务、动作和版本检查继续执行。两者通过后，才会返回这条任务允许的资料。

- 环境：`diversity-123-d9grnqfux221323bb`，上海。
- 函数版本：`$LATEST`；原生入口 TriggerId `5193211`、TriggerName `kysx4l8u8q`。
- 地址：`https://1443560658-kysx4l8u8q.ap-shanghai.tencentscf.com`。
- 实测没有签名的请求被腾讯云拒绝，HTTP 436、`http request cam error`。这只证明入口拒绝匿名调用，尚未证明合法程序调用和查库通过。
- 未改变原 `/api`、文章导入、静态网站和其他函数的路由。

## 本次代码

Hermes 与官网 AI 后台使用专用调用凭据签名。云签名使用 `Authorization`，原业务服务凭据使用 `X-Sales-Authorization`；后者仍交给原有客户／任务门禁。凭据不交给浏览器和模型。

Channel 函数从腾讯云给当前请求附加的可信运行信息中取得短期凭据，建立本次请求独立的数据库 SDK。不同请求不共用全局可变 SDK 身份。产品读取复用原已批准产品的筛选逻辑，通过请求自己的数据库连接读取，不复制整库，也不把未发布资料交给 Sales。

通用云签名和运行凭据处理位于 `packages/tencent-service-auth`；这是可供其他项目打包使用的源码模块，还不是已经发布的 npm SDK。

## 检查结果与未完成部分

- Sales 本机 132 项测试通过；新签名模块 3 项通过；Hermes 相关 48 项，47 通过、1 跳过；原公开产品读取 11 项回归通过。
- Sales 构建和独立部署包加载检查通过。运行凭据测试使用 SDK 网络替身，仅是代码接线检查。
- 真实平台的合法签名、运行身份查库、新官网询盘、真实 Resend 草稿、Test only 通知和群改稿替换尚未完成，不把本机通过写成线上验收。
- 官网长期管理 Key 已被 CAM 明确拒绝操作角色，不将该管理 Key 放进 Sales 服务。继续只读核对现有 GitHub 部署身份。
- GitHub 当前身份不能新增环境分支规则（403），未改变环境规则。只读检查采用现有允许的 `ai-cloudrun-deploy-*` 标签范围，专用 `ai-cloudrun-deploy-inspect-identity-*` 标签由独立只读作业处理，原部署作业明确跳过该标签，避免触发网站或 AI 发布。

## 范围与恢复

只配置这个 Sales 函数的入口、请求身份和它的两个调用方。先备份函数程序／配置、Hub 对应实例配置及数据库；权限或真实只读失败时不打开自动消费。恢复只回退本轮程序／配置，不用旧数据库覆盖现有询盘。禁止真实邮件发送；只在 Test only 做已授权测试。

## 表达与工具核对

本次实际核对了函数运行源码、现有公开产品读取器、SDK 3.17.2 源码、云端路由及腾讯 Function URL／运行头官方文档。项目 `.agents/skills/dev-pipeline/SKILL.md` 不存在，未宣称已执行该文件。

措辞从“官网资料接口没通”改为“官网没有登记 Sales 路由，请求落到了文章导入函数并返回 404”，补齐了调用方、实际接收程序和失败原因。
