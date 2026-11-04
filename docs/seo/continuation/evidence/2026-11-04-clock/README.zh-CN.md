# 商品自动更新：11月4日实际验收

已正式开启。腾讯云每分钟查看是否有公开商品待办；有待办才通过专用GitHub App启动构建。空队列不构建，已有任务在执行时不重复派发。Blog仍由文章服务实时返回，不走这条定时商品构建链路。

## 本次实际结果

|检查|结果与证据|
|---|---|
|安装授权|App 5606220、安装178433222，唯一仓库vibelingan/channel，Actions写、Contents/Metadata读；app-scope.json|
|代码检查|51项专项测试、脚本类型和格式检查通过；完整远端CI [41777116234](https://github.com/vibelingan/channel/actions/runs/41777116234)通过，源码7a025b86|
|部署与开启|[部署41778498332](https://github.com/vibelingan/channel/actions/runs/41778498332)、[启用41778728674](https://github.com/vibelingan/channel/actions/runs/41778728674)通过；fixed-stage.json、fixed-enable.json、fixed-enabled-live.json|
|真实自动通知|timer请求1483dab6-0ada-4521-9911-acaee72b90a5与运行reason同号；发起者channel-catalog-html-delivery[bot]；automatic-run-final.json|
|完整交付|[41778917828](https://github.com/vibelingan/channel/actions/runs/41778917828)成功，接受版本site-41778917828-1，528商品，使用当前公开内容和原已验收网页程序；delivery-result.json|
|没有重复派发|运行期间timer返回busy；同一时间段只出现这一条自动运行，随后队列空、timer返回idle；automatic-run-inventory.json、clock-idle-final.json|
|内容保持|前后各19项公开GET/HEAD；528商品清单hash及代表HTML相同，两篇Blog正文、图片资料、修订和时间均保持；public-before.json、public-after.json、public-comparison.json|
|浏览器交互|初始HTML、最新API、分类刷新、询盘入口通过，pageErrors空、业务写入0；browser-result.json|
|清理和其他app|两临时函数cleaned=true、unconfirmed=false；八个原函数均保留，除clock外ID、命名空间和修改时间不变；regional-cleanup-summary.json、final-cloud-readback.json|

GitHub将通过API发起的workflow_dispatch也显示为“Manually triggered”。这里同时核对timer日志中的通知编号、GitHub运行reason和App发起者；本轮没有人工点击启动这次网页交付。

## 验证范围

本次仅给现有商品安排一次内容重查，条件更新原已完成的SEO待办；没有修改客户商品名称、价格、发布状态或文章，也没有重做A/B程序恢复。原待办保持同一编号和token，最终checked。不是用修改客户数据来制造一次成功。

这次完整运行18分47秒。8分钟目标尚未达到，页面性能和交付速度调优按用户要求留待后续。Google/Bing最终是否收录也不由此验收保证，见[收录状态](../../review-2026-11-04/SEARCH-STATUS.zh-CN.md)。

## 本轮发现并修复的问题

首次启用时，查询最近100次GitHub运行超过1MiB上限，通知前停止，已关闭函数后修复。现在按分支和五类未结束状态各查询1条匹配记录；成功CI也按SHA、分支、事件和成功状态做存在性查询。不截取一小段历史假装完整、不提高正文上限。缺数据、过滤不符或读取失败时停止。官方参数依据：[Workflow Runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)。

真实App空闲查询五类合计180字节，真实活动任务查询约15KB；旧错误与新读回分别保存在initial-clock-error.json、bounded-query-live.json、bounded-query-busy-live.json。文件中不含私钥、短期通行证或云密钥。

## 哪里管理

[App安装范围](https://github.com/settings/installations/178433222)由vibelingan账号管理；两项变量和加密私钥在channel仓库的test环境，实际检查程序是既有上海CloudBase环境的catalog-seo-clock。没有修改main/test分支，没有新增收费边缘套餐或DNS变更。

安装位置、流程图、关闭及轮换步骤见[开通和维护说明](../../07-github-app-setup.zh-CN.md)。完整浏览器截图及执行明细保留在自动运行的site-delivery-evidence-41778917828-1 artifact，本目录保存后续复核所需的结构化回执。
