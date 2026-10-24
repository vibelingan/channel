# 本地 Blog 连接真实 CloudBase

这是基础 Blog 的开发入口，与 Agent 自动化设计分开。本轮没有为它创建云资源、修改跨域配置或部署网站。

## 页面、后端、数据分别在哪里

```text
本地浏览器 → Astro 的 /api 代理 → 127.0.0.1 的 Blog 专用服务
  登录 / me → 操作者指定的现有 HTTPS 管理接口
  草稿和图片 → 真实 CloudBase 文章集合与私有存储
```

该服务复用现有文章仓库、图片服务与当前账号体系。没有 dummy 函数、测试身份或到期窗口，不 seed 云端用户/商品，不回退到本地文件。正式文章发布能力关闭；商品、价格和 Alibaba 同步动作不在该服务的白名单中。

默认 `dev:api` 仍是原来的离线开发方式，不改变其他人的工作。注意它以前的 `TCB_ENV` 只将图片切到云端，草稿依然是本地文件。要让文章和图片都在 CloudBase，必须显式用下面的独立入口。

## 启动前的实际条件

- 使用已有真实环境；本项目现场约定的环境是 `diversity-123-d9grnqfux221323bb`，地域 `ap-shanghai`。切换环境必须重新核对，不能只照抄名字。
- 文章基础集合和 ADMINONLY 权限需要先准备。没有集合时明确失败，不自动创建。此前真实验收使用隔离集合，不能据此断言正式文章集合已经齐全。
- 现有管理接口 URL 必须正确，并允许已有管理员正常登录；本地不新建或伪造管理员。
- 本地后端取得受限的 CloudBase 服务端凭证，优先短期凭证。MCP 管理端已登录，不等于这个独立应用进程已经拿到凭证；不能把秘钥交给浏览器。
- 浏览器实际 origin 需要在 CloudBase 图片直传白名单中。旧的本次临时 `127.0.0.1:58484` 已移除，不能继续依赖。修改白名单属于实际云配置写入，按现场范围核对，不由启动脚本自动处理。

本地编辑会写入真实文章数据；它不等于离线沙盒。草稿仍然私有，只有现有发布流程成功后才公开。登录沿用真实后台，也会产生正常的登录记录。

## 配置与命令

在仓库根创建未入 Git 的 `.env.blog.local`，权限设为 600。以下是字段示意，不包含可用密钥：

```dotenv
TCB_ENV=diversity-123-d9grnqfux221323bb
TENCENTCLOUD_REGION=ap-shanghai
TENCENTCLOUD_SECRETID=填写受限凭证
TENCENTCLOUD_SECRETKEY=填写受限凭证
# 使用短期凭证时填写同一组的 token
TENCENTCLOUD_SESSIONTOKEN=
BLOG_AUTH_API_URL=https://填写现有管理接口的完整地址
BLOG_FRONTEND_ORIGIN=http://127.0.0.1:4321
BLOG_LOCAL_CLOUDBASE_CONFIRM=REAL_ARTICLE_DATA
PORT=3002
```

启动后端：

```bash
pnpm --filter @vibelingan-channel/local-server exec node \
  --env-file=../../.env.blog.local --import tsx src/blog-cloudbase.ts
```

另一个终端启动前端：

```bash
PUBLIC_CB_HOST=127.0.0.1:3002 PUBLIC_CB_PROXY=1 PUBLIC_BLOG_WORKSPACE=1 \
  pnpm --filter @vibelingan-channel/site dev --host 127.0.0.1 --port 4321
```

这套连接通过 Astro 的 `/api` 代理，**不要同时设置指向另一个来源的 PUBLIC_API_BASE_URL**，否则会绕过代理。端口被其他进程占用时换空闲端口，并同步修改后端端口、代理地址、页面 origin 和图片白名单；不要结束其他人的服务。

`PUBLIC_BLOG_WORKSPACE=1` 只让这次开发页面显示 Articles；未设置时原后台菜单保持不变。停止两个本地进程即可停止开发服务，不删除云端草稿、图片或集合。

## 怎样验收，怎样记结果

已有事实：上一轮通过独立真实 CloudBase 函数和存储，验证过草稿保存/重开、图片上传/字节校验、私有预览、权限和冲突。新入口的本地 HTTP 与实际安装 SDK 检查是另外一组证据，不冒充已经连正式集合跑过。

正式集合和配置就绪后，使用一篇明确的私有测试草稿，从页面登录、创建、保存、上传、预览、刷新和重开；再用非管理员及旧修订请求验证拒绝。独立读回真实文章 ID、修订和图片字节，确认没有写商品/同步集合。`/api/health` 只说明当前运行模式和目标，不证明网络、权限或写入已经验证。

这段只覆盖基础后台。本地服务不发起 SSG 发布、不跑 B→A 演练，也没有 Hermes 草稿接口。网站部署、恢复、重试与撤回继续按既有现场计划验收。
