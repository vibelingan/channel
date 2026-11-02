# SG5 人工审核、接管和受控发送

2026-10-29 第一期开通范围已缩减：保留查询/摘要预览、同群引用改稿、完整内容查看、精确批准与发送；暂停、恢复、人工接管及主动终止先只保留设计，不作为第一期实现门槛。既有撤权和状态拒绝规则保留。详见[本期范围](../evidence/2026-10-29-MVP-INTERACTION-SCOPE.md)。下文完整控制流程属于后续设计，不能当作本期已实现或必做。

2026-10-29 交互补充：官网29状态、企微18场景已形成设计原型及图册，尚未接入产品。企微采用关键待办/异常、精确任务卡片或引用、简短回执和按需私聊的建议，见[交互设计](../evidence/2026-10-28-INTERACTION-DESIGN.md)。本轮没有实现SG5控制入口，也没有改变现有机器人。

实施单元：SG5.1、SG5.2、SG5.3。共享 [状态规则](../contracts/STATE-AND-CONCURRENCY.md) 是本模块的准则。

## 最小使用体验

企微收到合并待办或需要人处理的任务卡片，显示业务、需求摘要、版本、关键缺项及尚未发送等事实。普通排队、读取和生成不逐条播报。人点按钮或引用带服务器短引用的通知来暂停、改稿或接管，每次操作有简短回执；对象不清楚时选择任务，不猜“最新一条”。日常控制不强制跳网页；完整HTML、附件和来源依据按需打开已鉴权预览。企微和网页批准共用后端命令及同一批准状态，仍须具体个人身份。

建议审核页属于Hermes销售流程，不在Channel新增一套任务中心。当前销售检出可读的门户是`vibelingan-ui-design/pages/portal.html`和Python `hub_server.py`，有对话与产物展示；nginx另有指向独立前端构建的`/app/`配置，但本检出没有完整`web/`源码。此前列出的React门户组件不能当作本分支已经具备。实施前先核对客户实际使用的门户、组件、会话与截图，再复用对应壳和视觉。拟议的`/portal/sales/tasks/:taskId/versions/:version`仍是设计路由，不是现有页面。

## 身份和预览

企微回调先验官方签名/加密，再将corp/user映射客户及角色。群成员、@机器人或自然语言自称销售不授予批准权。网页登录须能识别具体批准人；当前客户级portal token不能直接当作每位销售的实名身份。首期可用企微授权登录绑定操作者；未补齐前网页只读预览，企微走已验证操作人。不能为了多通道审批略过身份。

预览链接只含任务/版本引用，复制链接不转让权限。HTML在受限sandbox中渲染，禁止脚本、外部表单和顶层跳转，远程资源按邮件设计白名单控制；不把邮件HTML直接塞进应用DOM。附件通过鉴权bytes获取，用Blob/object URL预览并在卸载时revoke。所有审批按钮都由后端算可用性；前端显示可用不代表已授权。

## 控制和精确发送

```python
# 目标事务形状
with transaction():
    task = lock_client_task(actor.client_id, task_id)
    require_action(actor, 'sales.approve', task.business_line)
    require_revision(task, cmd.expected_task_revision)
    snapshot = require_current_snapshot(task, cmd.target_version, cmd.target_content_sha256)
    require_active_epochs(task, snapshot)
    approval = record_approval(actor, snapshot)
    enqueue_unique_send(approval)
# worker根据approval取固定payload，不重新接受模型提供的to/html。
```

修改正文/收件人/附件/发件人、有效来源修订、新来信、暂停/接管会撤销旧批准。拒绝的版本不能再次通过重复旧命令发送；恢复Agent不恢复批准。多入口命令有command_id，重复返回既有回执。暂停/接管作用最新任务，不因旧页面版本冲突而被拒；批准/恢复/改稿仍要求精确版本。首封跟进的logical_message_id改稿不变，发过/未知结果时不可通过新版本再发。

“停止”先使网关不再执行新外部动作，模型计算可合作式结束；已经提交provider的请求不能承诺撤回。任务显示dispatching/send_unknown时通知人结果待核对。批准与暂停竞争的事务规则、24小时provider幂等窗和外部原生操作限制详见状态文档。

## 接管Resend

`takeover`先撤销所有待发批准并进入takeover_requested。Resend只读查看可先提供；若有dispatching/send_unknown，必须对账，通知“正在确认此前发送结果，暂勿手动发送”。结果明确后才human_owned并移交发送权。无法自动对账需有权人完成明确的风险复核/人工解除，记录理由，不默默放行。客户随后可在原生界面改稿和发送。系统保留事件与结果，不继续覆盖草稿；交回时创建新的审核版本。若客户直接绕过接管在原生发信，异步通知无法绝对排除同时代发，必须公开这一边界。上线默认一任务单一发送通路，不能宣传全局exactly-once。

## 实施与验收

- SG5.1第一期：操作者/角色绑定、任务定位、改稿/批准命令、版本和epoch、audit/outbox。暂停/恢复/接管命令后置。先fake测试，不发信。
- SG5.2第一期：原生消息的摘要预览、附件清单及完整查看入口；按需要在现有门户壳内补固定预览，网页批准仍须具体个人身份。企微通知/卡片消费同一任务版本；不承诺任意HTML或自定义按钮CSS可直接进入群消息。
- SG5.3第一期：唯一发送操作、执行前复核、固定payload、结果不明对账、重复/旧版本及撤权拒绝。暂停/接管的UI与完整命令竞争在后续功能启用前验收。打开真实发送仍依赖SG8演练及客户授权。

目标用例 `wecom_text_without_identity_cannot_approve`、`ambiguous_send_requests_selection`、`company_token_is_not_individual_approval`、`web_and_wecom_duplicate_approval_one_send`、`v2_approval_cannot_send_v3`、`pause_wins_before_dispatch`、`stale_preview_can_pause_latest_task`、`takeover_waits_for_unknown_send`、`new_version_does_not_duplicate_sent_message`、`pause_after_dispatch_shows_reconciling`、`preview_link_does_not_grant_access`、`html_script_cannot_run`、`private_attachment_url_not_exposed`。浏览器验收包括手机企微内打开、登录返回原任务、失效版本提示和附件实际可读；不得只用mock证明生产身份。
