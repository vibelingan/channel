# 内容助手接入：底层设计

本页定义拟实现的合同，路径、字段和文件均为设计，不代表当前已有入口。沿用 TypeScript、Zod、文章核心和 CloudBase node-sdk 事务；不引入 CMS、AI 付费扩展或第二套数据库。

## 网站入口和路由

业务路径：`POST /api/integrations/v1/article-drafts`；结果查询：`GET /api/integrations/v1/article-drafts/{operationId}`。

建议接在现有管理函数中单独的 integration 路由，和浏览器 `{action,data,token}` 分发器隔离。集成入口验证服务凭证；现有后台继续验证用户会话。浏览器不能借 `action` 参数调用服务导入，服务凭证也不能调用后台 action。没有启用配置时返回明确的未配置结果。

上线前必须核对实际 CloudBase 网关路径映射和 GET/POST 支持，不能只写函数源码就宣布网址可用。正常网站部署入口不在本模块改写。服务器到服务器调用无须开放浏览器跨域。

## POST 请求

```http
Authorization: Bearer <keyId>.<secret>
Content-Type: application/json
```

```json
{
  "idempotencyKey": "wecom-task-123:article-1:generation-1",
  "externalTaskId": "wecom-task-123",
  "title": "How to choose a USB-C hub",
  "slug": "",
  "excerpt": "A draft summary for review.",
  "authorName": "",
  "seoTitle": "",
  "seoDescription": "",
  "format": "markdown",
  "body": "## Ports\n\nDraft text with **emphasis**."
}
```

| 字段 | 规则 |
| --- | --- |
| idempotencyKey | 1–128 位 ASCII 标识符；同一业务生成的重试必须复用；不作为身份凭证 |
| externalTaskId | 必填、最多 200 字符；只记来源，不信任为授权依据 |
| title | 必填、去空白后 1–200 字符 |
| slug、摘要、作者和 SEO 建议 | 沿用 `ArticleContentSchema` 长度限制；允许留空给人审核；不设置公开时间或发布状态 |
| format | `markdown` 或 `article-json-v1` |
| body | Markdown 字符串或现有有版本文章正文 JSON；一期仅文字 |
| 总量 | 整个请求最多 256 KiB；Markdown 最多 128 KiB；转换后的草稿记录仍遵守既有 384 KiB 限制 |

严格拒绝未知字段，包括 `siteId`、`actorId`、`collection`、`publish`、任意 callback URL 和动作配置。站点、集成身份、配额及权限都来自服务端配置/记录。

新建成功返回 201，同内容重放返回 200：

```json
{
  "ok": true,
  "data": {
    "operationId": "article-import-<sha256>",
    "articleId": "article-<sha256>",
    "state": "ready",
    "importedRevision": 1,
    "createdAt": "2026-10-24T04:00:00.000Z",
    "editUrl": "https://supplychainsai.com/admin?section=articles&article=article-<sha256>",
    "operationUrl": "/api/integrations/v1/article-drafts/article-import-<sha256>"
  }
}
```

`importedRevision` 是当时生成的初始修订，不冒充当前修订；客户编辑到第 2 版后，重复导入仍返回初始导入结果。响应不返回整篇正文、来源原文、凭证或账号信息。`ready` 表示事务已提交且草稿可编辑，不表示已公开。所有响应 `Cache-Control: no-store`；查询只读本集成的操作，跨集成与不存在统一返回 404。

错误：400 格式/不支持内容；401 无效、停用或过期凭证；409 同号不同内容或身份冲突；413 请求过大；429 配额超限并给 Retry-After；503/500 保存未确认。存储内部错误不回显原文、密钥或 SDK 详情。调用端遇到网络超时/5xx，只能用同号、同正文有限重试；400/401/409 不自动另造请求。

## 凭证与权限

拟新增私有 `articleIntegrations` 记录：`keyId`、固定 `siteId/integrationId`、secret 的 SHA-256 摘要、enabled、expiresAt、configRevision。secret 使用密码学随机的至少 32 字节，只在工具的安全配置和生成时交付；网站不保存明文。

入口先按 keyId 读记录并做恒定时间摘要比较；站点必须与运行环境绑定一致。写事务开始后再次检查 enabled、到期与 configRevision，避免在校验后停用凭证仍成功建文。普通浏览器用户不能管理该集合。轮换可以短期保留两个 keyId，绑定同一个 integrationId；停用旧钥匙后立即拒绝新请求，原导入记录仍属于该 integrationId。

持久限额拟为每个集成每分钟 10 次、每天 100 次新建，具体值可由部署配置降低。相同内容的重放不消耗新建额度。网关再限制请求大小和请求频率，避免恶意 GET/无效正文耗费资源。凭证、JWT、上传签名和原始正文均不进入日志；只记操作号、集成号、结果、耗时和错误分类。

## 数据和一次事务

| 集合 | 拟保存内容 | 保留规则 |
| --- | --- | --- |
| articleIntegrations | 受限凭证摘要、站点与启停状态 | 私有；轮换保留必要审计记录 |
| articleImports | 操作身份、原请求摘要、来源原文/格式、文章号、初始修订与创建时间 | 不因后续编辑改变；不返回来源原文 |
| articleImportLimits | 固定主键的分钟/日额度计数 | 复用有限文档；不每请求建新限额行 |
| articleDrafts | 现有草稿记录结构 | 沿用已有版本条件保存；不改公开版本 |

确定性操作号：`sha256([siteId,integrationId,idempotencyKey])`。用完整摘要产生文章号，不做先查询后随机新增。请求摘要覆盖规范化后的所有元数据、格式和原始正文；API v1 固定字段顺序、缺省值、换行和 Unicode 处理规则，绝不把转换后的编辑器 JSON 当请求摘要。转换器版本写入导入记录；协议升级要有独立版本及旧请求重放规则，不能只修改算法就让既有请求变成新文章。

```text
验证凭证和请求大小 → 转换并严格校验正文 → 开始事务
  重新验证同一凭证版本
  读 articleImports 的确定主键
  已存在：比对所属身份和原始请求摘要
    相同：返回既有操作，不保存草稿
    不同：409，零写入
  不存在：确认文章主键没有被占用；读取并检查额度
    写草稿 + 导入记录 READY + 更新额度
提交成功后才返回 201；提交失败三个写入全部放弃
```

导入写入须保持现有草稿行结构：`_id`、`draft`、`requestActorId`、`requestId`、`requestHash`、`searchTitle`。`draft.createdBy/updatedBy` 和 `requestActorId` 使用服务端派生的 `integration:<integrationId>`，不是伪造管理员；后续人工保存时 `updatedBy` 改为真实用户 ID。集成身份采用符合既有 128 字符 ID 规则的固定短编号，不能直接塞入任意外部任务号。后台读取草稿仍检查操作者的真实管理员权限，Agent 不能因此登录后台。现有 `repository.create` 要求管理员且按另一种规则生成文章号，**不能直接套用它或绕过其权限判断**；应新增独立的集成事务入口，只复用已核对的行校验、写入确认和正文规则。来源原文仅放 `articleImports`，不向严格草稿 schema 塞入新字段。

使用现有安装的 `@cloudbase/node-sdk@3.17.2` 的 `runTransaction`、`doc.get` 和 `doc.set`，不增加伪造 SDK 方法。保存回执检查沿用现有文章适配器：零写入或提交结果未知都不能返回成功。不得在事务内下载图片、调用 Agent 或发送群消息。默认保留已有字段和历史记录，不安排数据库 down 或清库。

重试流程不重写当前草稿，因此不会把人工第 2 版覆盖回 Agent 第 1 版。若草稿因异常丢失，查询与重放明确返回资源不可用，不再回复一个能编辑的假链接；不靠重放重新创建被移除的内容。并发同号由同一事务主键仲裁；并发不同号产生不同草稿。未来“建议修改已有文章”应是独立提案功能，不能暗改这个创建合同。

## Markdown 与格式适配

采用已锁定生态中的 mdast/GFM 解析库，再显式映射到 `packages/articles` 的受支持节点。允许段落、H2–H6、粗体/斜体/删除线、引用、列表、受限链接、代码、分隔线和普通表格。代码块语言及表格尺寸继续遵守既有 schema。

正文 H1、HTML、脚注、任务勾选框、未知节点、复杂表格和图片明确返回位置与原因。正文标题由独立 title 字段负责，不静默删除 Markdown 第一行。链接继续只允许本站绝对路径、锚点和 HTTPS；不执行 HTML/脚本，不从外链抓资源。`article-json-v1` 也走同一校验并拒绝图片节点。转换器将来可替换；持久格式仍是自有的有版本文章 JSON，不依赖 Tiptap 专有存储。

## 客户端工具和编辑链接

两个工具：

```text
channel_blog_create_draft(input) -> confirmed draft identity + editUrl
channel_blog_get_import(operationId) -> the same integration's confirmed result
```

客户端固定 apiOrigin、siteOrigin 和服务凭证，禁止重定向，15 秒请求超时、最多 32 KiB 响应，严格校验响应身份及编辑 URL。重试最多三次、复用相同请求号；不因 409 自动换号。服务配置不能由模型参数覆盖；工具没有通用 fetch/SQL/管理员 action 能力。

MCP 只是工具包装协议。拟交付一个 stdio 适配器，将以上工具映射到 HTTPS。Hermes 的配置必须显式传安全环境变量，不能把服务密钥写进工具说明、prompt 或群消息。当前运行环境是否支持限定到单个内容助手/客户的配置仍需接入时确认；如只会全局注入，不直接挂载客户钥匙。

后台需补三个小接点：读取 `/admin?section=articles&article=<id>`；未登录时在 returnTo 保留这个安全本站路径；登录和刷新后打开同一草稿。当前登录页是静态产物，不能只依赖构建期 `Astro.url` 获取查询参数，浏览器端必须读实际 URL。返回地址拒绝跨站、反斜杠和控制字符；文章 ID 必须校验，URL 不能携带会话或服务密钥。列表和编辑继续复用现有 React Query、DashboardShell 和编辑器，不重做页面。

## 与现有发布和本地开发的关系

导入只新建草稿。按2026-10-26确认的方案，管理员人工发布时，后台事务确认指定修订为公开版本；Astro读取该公开版本返回HTML，列表、图片和sitemap同步读取当前状态，无须GitHub内容构建。助手生成的草稿即使SEO字段完整，也不会自行变成公开网址。

本地页面可以通过本地后端直接使用真实 CloudBase。该开发方式不依赖 dummy 函数，也不要求先部署 Agent API；细节见 [本地连接说明](../LOCAL-CLOUDBASE.zh-CN.md)。真正启用导入仍需发布网关路由、私有集合和凭证；这些不是本地测试自动附带的动作。
