# 一次性开通商品更新通知

## 为什么不是加一个 SSH 公钥

SSH 密钥让服务器下载或推送 Git 代码。此次需要的是：腾讯云发现商品有更新后，通知 GitHub 启动已经写好的网页发布工作流。这是 GitHub API 的权限，仓库 SSH 公钥不能代替。

选择专用 GitHub App，是为了不把管理员自己的登录令牌长期放进云函数。它只安装到 `vibelingan/channel`，只申请读取源码、读取仓库基本信息和启动 Actions。它不能修改源码或管理仓库。App 私钥用于换取短期安装令牌，程序自动换新，不需要客户每十四天重新配置。

## 账号持有人操作

1. 在当前 Mac 打开本次授权说明页。临时地址只在本机监听；过期后在原 SEO 项目执行 `node tools/catalog-seo/github-app-setup.mjs`，使用它输出的新链接，不要重复创建另一套应用。
2. 点击“查看 GitHub 授权范围”。检查当前 GitHub 账号为 **vibelingan**。如果是其他账号，在浏览器里自行切换；不用提供密码给 agent。
3. 页面上的名称为 **Channel Catalog HTML Delivery**。确认权限只有 Actions 的读写、Contents 的读取和 GitHub 自动带的 Metadata 读取，再点击创建。
4. GitHub 自动返回本机，页面显示“应用已创建，私钥已安全保存”。私钥保存到 `~/.config/channel-catalog-seo/github-app.json`，文件权限 0600。不贴群、不发聊天、不提交 Git。
5. 点击安装链接。选择 **Only select repositories**，只选 **channel**。确认后安装，回复“已安装”。不要选择全部仓库。

这几步必须由持有 GitHub 账号的人完成。SSH 到腾讯云服务器并不能代替账号所有者批准 GitHub 权限。本模块也不需要登录内容助手或发布助手机器。

## 之后由部署程序完成

读取 App ID、安装 ID及私钥，先确认安装所有者为 vibelingan、范围为指定仓库，再交给独立 CloudBase 定时函数；不复用个人 gh 登录凭证或范围未知的 GH_PAT。不设置公开 HTTP 路由，数据库状态仅云函数可读写。

先保持定时函数关闭：验证真实空队列、待办、重复通知和故障补漏，以及真实 HTML 和恢复，再开启每分钟检查。其余网站发布仍使用原来的共享部署队列。普通发 Blog 不受此定时器控制，文章仍由文章服务器实时返回。

## 停用与换钥匙

临时停止自动更新：先关闭 `CATALOG_SEO_CLOCK_ENABLED`，正常网站仍可访问、手动部署仍可运行。需要撤销权限时，在 GitHub → Settings → Applications → Installed GitHub Apps，找到本应用后暂停或卸载，影响仅此自动通知。

私钥轮换：在同一个 App 生成新私钥 → 用新私钥核对指定仓库并完成一次通知 → 更新定时函数 → 读回确认 → 撤销旧私钥。不要先删除旧钥匙，也不要更换 App 身份或新建相似名称的应用。

## 已核对的官方依据

- [GitHub App 的清单创建方式](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [腾讯云定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)：采用七字段表达式 `0 * * * * * *`，每分钟检查一次；定时任务可能重复触发，通知租约和现有部署锁仍然必须保留。
