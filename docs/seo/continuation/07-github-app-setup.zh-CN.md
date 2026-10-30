# 一次性开通商品更新通知

## 为什么不是加一个 SSH 公钥

SSH 密钥让服务器下载或推送 Git 代码。此次需要的是：腾讯云发现商品有更新后，通知 GitHub 启动已经写好的网页发布工作流。这是 GitHub API 的权限，仓库 SSH 公钥不能代替。

选择专用 GitHub App，是为了不把管理员自己的登录令牌长期放进云函数。它只安装到 `vibelingan/channel`，只申请读取源码、读取仓库基本信息和 Actions 读写。它不能直接修改源码或管理仓库。Actions 权限在 GitHub 上覆盖该仓库的工作流；本项目代码再固定允许启动的工作流、分支和输入。App 私钥用于换取短期安装令牌，程序自动换新，不需要客户每十四天重新配置。这里的令牌是 GitHub 给云函数的短期通行证，与 AI token 无关，不调用模型。

## 账号持有人操作

1. 在当前 Mac 打开本次授权说明页。临时地址只在本机监听；过期后在原 SEO 项目执行 `node tools/catalog-seo/github-app-setup.mjs`，使用它输出的新链接，不要重复创建另一套应用。
2. 点击“查看 GitHub 授权范围”。检查当前 GitHub 账号为 **vibelingan**。如果是其他账号，在浏览器里自行切换；不用提供密码给 agent。
3. 页面上的名称为 **Channel Catalog HTML Delivery**。确认权限只有 Actions 的读写、Contents 的读取和 GitHub 自动带的 Metadata 读取，再点击创建。
4. GitHub 自动返回本机，页面显示“应用已创建，私钥已安全保存”。私钥保存到 `~/.config/channel-catalog-seo/github-app.json`，文件权限 0600。不贴群、不发聊天、不提交 Git。
5. 点击安装链接。选择 **Only select repositories**，只选 **channel**。确认后安装，回复“已安装”。不要选择全部仓库。

这几步必须由持有 GitHub 账号的人完成。SSH 到腾讯云服务器并不能代替账号所有者批准 GitHub 权限。本模块也不需要登录内容助手或发布助手机器。

## 之后由部署程序完成

读取 App ID、安装 ID及私钥，先确认安装所有者为 vibelingan、范围为指定仓库，再交给独立 CloudBase 定时函数；不复用个人 gh 登录凭证或范围未知的 GH_PAT。不设置公开 HTTP 路由，数据库状态仅云函数可读写。

先保持定时函数关闭：真实 HTML 和恢复验收完成，再安装 App 并用它核对仓库范围、空队列、通知与故障补漏，最后开启每分钟检查。其余网站发布仍使用原来的共享部署队列。普通发 Blog 不受此定时器控制，文章仍由文章服务器实时返回。

## 停用与换钥匙

临时停止自动更新：先关闭 `CATALOG_SEO_CLOCK_ENABLED`，正常网站仍可访问、手动部署仍可运行。需要撤销权限时，在 GitHub → Settings → Applications → Installed GitHub Apps，找到本应用后暂停或卸载，影响仅此自动通知。

私钥轮换：在同一个 App 生成新私钥 → 用新私钥核对指定仓库并完成一次通知 → 更新定时函数 → 读回确认 → 撤销旧私钥。不要先删除旧钥匙，也不要更换 App 身份或新建相似名称的应用。

## 已核对的官方依据

- [GitHub App 的清单创建方式](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [腾讯云定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)：采用七字段表达式 `0 * * * * * *`，每分钟检查一次；定时任务可能重复触发，通知租约和现有部署锁仍然必须保留。

## 管理员可以照做的命令

先在原 SEO 项目运行 `node tools/catalog-seo/github-app-setup.mjs`，保持终端运行，在它给出的本机链接完成上面五步。若提示已存在私钥文件，先确认它属于本次应用，不删除后重建。

安装完成后，可在 GitHub 网页进入 `vibelingan/channel → Settings → Environments → test`：

1. 将 App 页面显示的 App ID 添加为环境变量 `CATALOG_GITHUB_APP_ID`。
2. 从安装详情地址的 `/installations/<数字>` 取得安装 ID，添加为环境变量 `CATALOG_GITHUB_INSTALLATION_ID`。它与 App ID 不是同一个数字。
3. 将本机私有 JSON 中的 `privateKey` 值添加为环境密钥 `CATALOG_GITHUB_PRIVATE_KEY`。只将 PEM 本身写入密钥，不复制整个 JSON，不贴到群里。
4. 让部署程序先检查 App 安装所有者、仓库及权限，再运行 `catalog-clock-enable`。此前必须已有通过验收的网页程序和对应接受版本；检查失败就保持关闭。
5. 读回函数开启状态、程序提交和唯一的每分钟定时器，再看一次实际商品待办的处理记录。此时才能称自动更新已开启。

也可以由已获得授权的本地 agent 通过 `gh secret set ... --env test` 直接从权限为 0600 的文件读取并设置，避免手工复制。不要在 shell 参数、日志或聊天里显示私钥。账户登录和一次性创建应用仍由账号持有人操作；不需要新增仓库 SSH 公钥。
