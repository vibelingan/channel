# SG2.4 Hermes 持久任务读取授权

2026-10-28。用户要求继续下一步。本单元从 Channel e2764b9c、Hermes 40fbac5 开始，仅在原销售分支继续。先推送本计划，再写代码；不启动额外 Agent，不改其他业务，不部署或发信。

## 交付范围

Channel 的 SG1.3 已调用固定的 `POST /sales/authorize-read`，Hermes 尚无此路由。本单元把它接到客户专属 MySQL 中的当前任务记录。复用既有 Intake 事务、数据库归属锁、fresh binding 检查及固定消费的 `issue_task_permit`，不另建任务平台或修改共享 Hub。

新受理的任务同时保存一条等待核验的控制记录：`source_verified=false, mode=disabled, work_state=waiting, task_revision=0`。缺记录的旧任务同样拒绝，不自动补成已核验。现有 outbox 和 worker 的 accepted 仍只代表持久排队，不能借此获得准备资料的许可。

本轮不提供从 HTTP 把任务标成已核验或恢复的入口。真实 Channel 来源核验、handoff/lease 签发及准备状态的激活归下一单元。测试用例会在隔离数据库内建立服务器控制的合成授权状态，不能把它当成生产核验器。

## 接口与数据

- 请求和响应继续用 `sales-auth/1`，不改共同 schema。调用方必须是固定 Channel 控制连接，使用独立的 `SALES_CONTROL_TOKEN`，不能复用 source/runtime token；未配置时此路由拒绝。
- `sales_task_authorizations` 绑定真实 task/current run、来源交接摘要、控制版本、核验状态、工作状态及允许动作。新任务在原事务中创建等待记录；迁移仅由原 install 显式执行。
- 许可从 MySQL 读取，不接受请求附带 authority。再检查当前绑定、连接是否仍启用、runtime/环境/业务和实际 run 是否一致。批准的动作仅为三种读取，不包含发送或原始 DB/文件工具。
- `sales_read_requests` 持久绑定 task/request_id 与完整请求摘要。Channel 在同次读取前后复查可重复相同请求；相同 ID 换参数、run 或版本拒绝。记录不跨客户库共享。
- 事务结束后才返回最长 10 秒的许可。网络响应丢失可按相同请求重试。状态已暂停／接管、来源未核验、数据库或绑定异常一律拒绝；不使用正向缓存。

## MIU：许可必须读取当前系统事实

现有形状：`sales_server` 只处理 events / runs/accept；`Intake.accept` 保存任务与队列，没有能表达暂停和来源核验的持久控制记录。若直接把请求里的 `authority` 交给纯函数，调用者就能替自己授权。

目标形状：

```python
authenticate_dedicated_control_connection(token)
with intake_transaction_and_owner_lock() as cursor:
    authority = load_current_task_and_run_from_mysql(cursor, request.task_id)
    require_current_binding_and_runtime_connection(request)
    permit = issue_task_permit(request, authority, now())
    bind_request_identity_to_hash(cursor, request)
return permit
```

MySQL 负责跨进程持久化、唯一约束及事务串行化；现有 owner 锁保持试点低并发模型。请求记录与许可判断同事务提交，失败回滚。跨 HTTP 的暂停仍有在途窗口，Channel 返回数据前继续在线复查；不能声称分布式原子撤权。

不采用进程字典、请求自带状态、旧任务默认通过或共享全局任务库。代价是数据库异常时读操作失败，以及试点 owner 锁限制吞吐；暂不为未测量的高并发重构队列。

## 实施与验收

- [ ] 先写真实 HTTP 路由测试，观察尚无接口时 404 而期望 200 的失败。
- [ ] 新增持久状态与请求摘要表；新受理任务保存等待记录，失败与任务/outbox整体回滚。
- [ ] 接入独立连接、实际数据库 authority、当前 run/状态/版本和幂等请求检查。
- [ ] 真实 MySQL 验证：等待拒绝、重启保留、同 ID 换参数拒绝、同客户不同任务、错客户/run/连接、暂停/接管/版本变化、配置/数据库异常拒绝、并发重复一致。
- [ ] 复核后补反例；Hub 回归、33 项 dispatcher 自检、MySQL 与 A/B Docker CI 均通过，再记录提交号并推送交接资料。

重点兼容边界：不改 Channel 原询盘保存、产品/pricing/SEO 或其他 Agent。HTTP 禁用仍不初始化数据库。接口只返回许可摘要与有效期，不返回询盘正文、凭据或数据库错误。

文案按 humanizer 及 plain-technical-writing 规则复核；本计划实际核对了 D1、SG1.3 permit-client、Hermes intake/http/service/boundary、SQL 和既有测试。将“已接入 Sales Agent”明确写成“读取许可接到任务库；来源签发和模型执行仍未接通”。
