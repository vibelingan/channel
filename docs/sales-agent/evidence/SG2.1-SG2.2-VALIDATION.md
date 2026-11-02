# SG2.1／SG2.2 客户运行和可靠接收

2026-10-24。两个单元在独立 Hermes worktree、分支 feat/sales-agent-runtime 实施，基于 main 52d0365。最终代码提交 [2fbc50c](https://github.com/vibelingan/hermesinfra/commit/2fbc50c466b2168aa57ef746eaeb0e2172c51e66)，[最终 CI 40065259862](https://github.com/vibelingan/hermesinfra/actions/runs/40065259862)成功。代码位于 [sales_flow](https://github.com/vibelingan/hermesinfra/tree/2fbc50c466b2168aa57ef746eaeb0e2172c51e66/deploy/hub/sales_flow)。未创建 PR、合并、部署或发送邮件。

## 当前交付

SG2.1 固定客户/业务/安装/runtime/知识范围/环境/epoch；每次文件、工具及事务都重新检查绑定。文件通过 no-follow 目录描述符读取，拒绝路径越界、symlink、hardlink、非普通文件和超限内容。0700私有根目录有持久归属标记，禁止不同客户误用同一目录。容器只挂本客户 HOME、只读知识和本次 run；只读根文件系统、非 root、无网络、无多余 capabilities，不传 provider 密钥。模型及工具 I/O 由可信 broker 处理，实际销售推理循环归 SG3。

SG2.2 使用单客户专属 Sales 服务和数据库，复用原 Hub Dispatcher、State、幂等键和 assignment/outbox 表结构，没有修改共享 Hub 入口或路由。一次 MySQL 事务保存事件、根任务、run、prepare 分支、assignment 和 outbox，再返回202。重复投递只生成一个根任务；换投递ID不新建任务，复用ID或不可变内容冲突返回409。worker再次核对归属、run和epoch，持久接收后才返回回执。领取后中断由原租约恢复，重投同一run只留一条worker inbox。

这是专属服务，不代表原在线定海和其他文章 Agent 已自动采用此隔离。数据库独立部署是当前试点取舍，增加接入配置，避免修改现有平台共享数据结构。迁移必须显式执行，普通启动默认关闭；生产数据库要求验证证书和主机名的TLS，worker默认HTTPS。源服务token和runtime token分别设置，不能混用。

## 开发、复核、测试证据

1. 先提交推送实施说明6c4b512。SG2.1 的1917c23通过[首轮CI](https://github.com/vibelingan/hermesinfra/actions/runs/40064573989)，包括实际并行A/B容器，再开始SG2.2。
2. SG2.2测试提交0d6e4d5在[MySQL CI](https://github.com/vibelingan/hermesinfra/actions/runs/40064753824)观察到缺实现的预期失败，确认数据库已连通；实现后b72a11b的[CI](https://github.com/vibelingan/hermesinfra/actions/runs/40065031634)通过。
3. 代码复核补出跨客户共用root、Python将True等同整数1、生产DB缺TLS约束等问题。先补失败反例，再修复；结果写入最终提交2fbc50c。本会话按合同、归属、过期、并发、回滚及重启逐项复核，使用pyflakes静态检查和black整理新代码。
4. 71个不同测试用例：本地60项通过，11项因缺少运行中的Docker/MySQL而明确跳过；CI显式执行10项真实MySQL测试及1项并行Docker测试，无跳过。另有原dispatcher的33项自检通过。原Hub基线46项仍通过。不可把本地的“跳过”算为通过。
5. MySQL测试覆盖16次并发提交、重启后去重、事务故障时五类记录全回滚、事件ID冲突、错数据库归属、worker重投、错目标、撤权、旧epoch，以及真实HTTP受理。Docker检查两客户只能读取自己的知识/记忆，不能看到对方宿主目录、不能写知识目录或访问外网。

Open Code Review CLI 确实尝试，但因未配置模型服务失败，没有生成独立模型审查报告。未改动用户模型配置；当前review是本会话代码复核及反例测试，不能称为第三方审查。完整实施记录见[Hermes说明](https://github.com/vibelingan/hermesinfra/blob/2fbc50c466b2168aa57ef746eaeb0e2172c51e66/docs/sales-agent/IMPLEMENTATION.md)。

## 与其他工作流及线上验收的边界

原Hermes检出的三份未跟踪文档保持原样；共享hub、hubkit、hub_server、web和现有部署compose没有代码变更。既有regression工作流只补Sales校验依赖，新增销售CI不部署。Channel本轮只更新销售文档和计划，没有修改pricing/SEO、产品或询盘保存代码，也没有合入其他分支。共同合同从Channel e2f51c7c逐字节复用并校验来源hash。

接收202只表示任务可靠保存，worker accepted只表示等待准备；尚未实现SG1.2的官网自动通知/补扫，SG2.3的成果manifest，或SG3的实际内容准备。下一步按依赖可推进SG1.2和SG2.3。本轮不继续它们。

Docker/MySQL为隔离CI资源，不是当前客户线上Hermes。基于实际部署版本、客户runtime和真实Channel/Resend账号的联调仍按[真实计划](LIVE-TEST-PLAN.md)执行；邮件草稿及真实测试邮箱投递没有执行。
