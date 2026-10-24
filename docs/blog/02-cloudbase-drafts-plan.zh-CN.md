# CloudBase 草稿存储实施计划

> 按已确认的模块 02 与 NEXT-STEPS 逐项执行；当前会话直接实现，先失败测试再写代码，保留步骤和证据。原 SEO 分支不变，不创建 PR、不部署、不操作云端资源。

**目标：** 给现有 ArticleRepository 提供真实 CloudBase SDK 适配器，保持管理员权限、重复创建、修订保存、摘要列表和只读快照规则。

**架构：** `packages/db` 增加独立的文章适配器，通过现有 `@cloudbase/node-sdk` 的数据库注入。创建用操作者/requestId 的摘要生成确定性文档键，文章和去重信息放在同一文档；保存通过数据库事务读取版本后完整替换文档。后台云函数注入适配器，本地 JSON 适配器继续用于本地编辑开发。

**技术栈：** Node 22.13.0 开发、Node 20.19.0 函数产物；TypeScript、Zod、`@cloudbase/node-sdk@3.17.2`、`@cloudbase/database@1.4.3`。不新增第三方依赖。

**设计：** [模块 02](02-admin-drafts.zh-CN.md)、[开发顺序](NEXT-STEPS.zh-CN.md)。

## 约束和已核对的合同

- 当前授权是写代码、离线检查、提交并推送原分支；真实集合创建、权限设置、数据库写入和部署仍不执行。
- CloudBase MCP 官方站点搜索返回 Domain forbidden；本轮改用腾讯云官方 GitHub SDK 文档，并与安装包源码及运行时行为对照。Context7 不可用。
- 官方资料：`TencentCloudBase/node-sdk` 提交 `b3c9dda879254ef769adc20aefbb116dd46c5eb7` 的 `docs/database/database.md`，包含事务 get/set/commit/rollback/runTransaction。
- 安装包的事务 get 返回 `data: object|null`；旧文档的数组描述不直接当成当前返回形状。
- 安装包 `runTransaction` 对 `DATABASE_TRANSACTION_CONFLICT` 重跑整个回调，默认最多三次重试；回调中不放网络副作用、随机编号或事务外写入。
- `doc.set(data)` 发送 `database.modifyDocument`，`merge:false, upsert:true, transactionId`；data 不能包含 `_id`。必须检查写入确认，不能只看 Promise 已结束。
- 草稿请求仍限 256 KiB、记录仍限 384 KiB。列表游标覆盖云端确定性编号及合法查询长度，不返回正文。
- 文章集合仍不进入通用 CRUD；权限使用真实用户记录，不相信旧令牌中的管理员角色。

## 重点检查

1. 两个创建或保存请求重叠，数据库事务冲突重试后仍只有一篇或一个版本获胜。
2. 事务回调重跑时账号已停用/降级，重新读当前用户并拒绝。
3. 完整替换后删掉的正文节点不会被数据库嵌套合并保留。
4. SDK 返回错误、零写入、坏记录或提交失败，不伪装成功，不泄漏原始数据库错误。
5. 分页只读取摘要字段，查询作为文字处理，不能注入正则；长 Unicode 查询生成的游标仍可继续请求。

## 顺序与文件

- [x] 1. 云端创建/读取/保存：新增 `packages/db/src/article-repository.ts` 与 `article-repository.test.ts`；导出 `createCloudBaseArticleRepository(db): ArticleRepository`。用实际安装 SDK、仅替换网络传输的离线夹具验证请求与结果，不声称是真实云数据库。
  - 测试先覆盖创建重试、重开、异内容冲突、账号检查、两个保存竞争、相同正文、失败回滚和完整替换。
  - 先运行并看到缺实现的失败，再增加实现并跑文章相关测试。
- [x] 2. 列表、预览依赖及旧快照：摘要投影、唯一键翻页、文字标题查询、绑定游标、只读快照校验；补大小、腐坏和 SDK 错误测试。必要的共享摘要解析留在 `packages/articles`，不让浏览器入口引入 SDK。
  - 用已有 executeArticleDraftRequest 走长查询连续分页，证明服务的输入上限接受自己生成的游标。
- [x] 3. 接线与 SDK 检查：`packages/db/package.json` 增加 articles 工作区依赖及文章导出；admin 云函数注入真实适配器；补入口和实际 SDK 传输合同检查。集合及权限初始化只留明确的准备/核对清单，不自动创建。
- [x] 4. 本地审查与交接：针对权限、版本、完整替换、错误确认做故意破坏检查；模块、全仓、类型、lint、SDK、函数构建及 Node 20 产物检查通过。更新 brief、下一步和跨端交接，见本轮 worklog。

## 执行记录

- 基点：`1f7fac43e0ff6794e09a10dfada909020d1df664`。
- 保留上轮未提交的编辑器要求和 NEXT-STEPS，本轮一并推送，方便其他端继续。
- 设计决定：只先完成草稿适配器这一段；页面和真实浏览器属于紧接着的编辑器交付。真实 CloudBase 初始化/验收尚未授权执行，不能把离线 SDK 传输测试写成真实库通过。

交付步骤：提交并推送 `feat/seo-foundation`，随后按准确 SHA 读回远端 CI；实际提交和结果由当次最终 brief 给出，不预先把远端结果标成通过。
