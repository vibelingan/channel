# 02 后台草稿服务

本模块的本地部分 BLOG-D1 已实现，依赖 [01 文章核心](01-content-core.zh-CN.md)。现有管理员可以经 `articleDrafts` 请求创建、读取、分页列出、保存和预览草稿。真实 CloudBase 适配器 BLOG-D2 尚未接入；未注入文章存储的云函数入口会明确拒绝。本文保留完整设计，实际测试见[本轮记录](02-admin-drafts-worklog-2026-10-22.zh-CN.md)。这些改动不会把文章公开到网站。

## 放在哪里，谁负责什么

`apps/functions/admin/src/handler.ts` 已有登录校验和 `revalidateSession`，后者会重新检查账号是否仍有效。文章操作接在这个校验之后，转交独立的文章服务；不另写登录系统，不把正文保存逻辑塞进商品同步或定价服务。

文章服务依赖 `ArticleRepository`，方法限定为创建、分页读取、按编号读取、按修订保存、读取指定公开快照。分别提供本地和 CloudBase 适配器；不向调用方暴露任意集合名、条件或数据库命令。文章集合不注册到现有通用 create/update/remove 入口，避免绕过版本、权限和发布规则。

首期写作和管理仅对现有 `admin` 开放；不把现有普通会员自动变成文章作者。以后需要作者角色，再单独补权限和可见范围。Hermes 使用 05 的专用身份，不能借管理员会话。

## 存储合同

以下为拟建文档集合，不是本轮已经创建的资源，也不涉及 PG 或商品 schema。

| 集合 | 单条记录与约束 |
| --- | --- |
| `articleDrafts` | 一篇文章一个不可变 id；保存 01 的内容、revision、服务器时间和编辑者、已公开版本引用。存储读取必须重新校验，不能用 TypeScript 类型当数据库校验。 |
| `articlePublications` | 按 articleId/revision/contentHash 唯一保存不可变候选内容；是否真正上线由 04 的发布记录决定。公开 API 只能读取已验收的版本，不能直接列出这个集合。 |
| `articleSlugs` | 固定站点内 slug 的占用记录；创建/发布占用必须使用唯一键和事务，不能先查询再写入。撤回仍保留占用，避免旧链接被另一篇文章接管。 |

媒体和发布任务分别由 03/04 负责，不在草稿记录里塞访问凭证、公开存储地址或整个历史正文数组。列表返回摘要和当前修订，详情才返回正文。正文及数据库记录大小分别设限；不能因为 01 允许 512 KiB 就忽略整条云数据库记录的上限，接入时以已核对的平台上限设置更小的 HTTP/存储额度并补边界测试。

## 后台请求

沿用现有 `{ action, token, data }` 请求及成功/错误响应封装，新增 `articleDrafts` action，内部用严格的 `operation` 区分操作。下表已接入本地后台入口；生产存储和编辑器界面仍未接入。

| operation | data 中的业务输入 | 成功结果 |
| --- | --- | --- |
| `create` | `content`、稳定的 `requestId` | 完整 draft；id、revision、时间、编辑者由服务器生成 |
| `list` | `cursor?`、`limit`（1–50）、标题查询（最长 100 字） | 摘要数组、下一页 cursor；不泄露私有图片地址 |
| `get` | `articleId` | 完整 draft 和独立的公开状态 |
| `save` | `articleId`、`expectedRevision`、`content` | 已保存 draft；相同内容不增加 revision |
| `preview` | `articleId`、`expectedRevision` | 指定已保存修订的正文 JSON 和媒体编号；图片字节另走鉴权入口 |

缺身份返回 UNAUTHORIZED，角色不允许返回 FORBIDDEN，不存在返回 NOT_FOUND，结构错误返回 VALIDATION_ERROR，过期保存返回 CONFLICT 并附当前 revision。不得把正文、token 或数据库堆栈写进公开错误。单次请求先限制字节数，再解析正文。

创建重试用 requestId 保证不重复建文；同一 requestId 对应不同内容必须冲突。保存必须在一个事务里读取 revision、调用 `saveArticleDraft`、写回结果；事务回调可重试，因此不能在其中发消息、上传图片或创建其他非事务副作用。冲突时不替用户合并正文，也不自动用新 revision 覆盖。

## 并发、权限与适配器验收

`ArticleRepository` 的事务返回“成功、修订冲突、不存在”，不把云数据库原始错误传上来。CloudBase 方法和事务重试语义在实现前按 `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` 核对官方文档、已安装 SDK 类型和源码；若原接口不支持所需事务，不添加虚构 shim，也不降级成非原子保存。

本地适配器验证规则，真实 CloudBase 测试验证实际并发和权限，两者分开记录。当前线上窗口未开放时可以完成适配器代码和离线合同测试，不能写成数据库已验收。

## MIU 与交付

| MIU | 独立交付 | 必须通过的检查 |
| --- | --- | --- |
| BLOG-D1（本地已实现） | 文章服务、Repository 合同、本地适配器、后台 action 与现有鉴权接线 | 未登录/停用账号/普通会员拒绝；请求重放不重复；两个相同 revision 的保存只有一个成功；通用 CRUD 不能旁路写文章；草稿修改不改变公开引用 |
| BLOG-D2 | CloudBase 适配器、集合初始化与私有权限读回 | 真实数据库并发保存、事务失败无半条记录、客户端不能直读草稿、失败重试不重复；现场未运行前保留未验证 |

本模块不增加客户可见 UI。新增集合初始化只允许明确列出的文章集合，不调用商品迁移、不更改 Alibaba 同步数据。上线前检查最新 main 的管理入口变化，再接线。
