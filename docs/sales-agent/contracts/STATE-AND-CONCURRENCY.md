# 状态、优先级与发送边界

2026-10-26：本次[权限设计 D1](../SECURITY-AND-TOOLS-DESIGN.md)待确认，开发暂停。客户级撤权用绑定control_epoch，单任务安全变更用task_revision；共同schema尚未升级，不能把旧Approval 1.0当新门禁。

2026-10-23。所有状态为目标设计；不是把现有文章发布状态机直接改名。

## 1. 分开记录工作、控制和发送

| 对象 | 状态 |
|---|---|
| Sales任务工作 | accepted → preparing → needs_input 或 review_ready → finished；失败可进入 failed，按原因显式重试 |
| 控制模式 | agent_active / paused / takeover_requested / human_owned / disabled |
| 邮件版本 | draft / review_ready / superseded；版本一经固定不覆盖 |
| 批准 | valid / consumed / invalidated / expired |
| 发送操作 | queued / dispatching / accepted / delivered / failed / send_unknown / cancelled |

任务完成不等于邮件已送达；Resend接收请求成功只记accepted，投递回调才记delivered。打开邮件、退信、投诉是独立事件，不作为销售成交状态。原后台的completed/closed表示客户公司的操作人处理业务完成，不是官网访客能关闭询盘，也不是Agent是否还在运行。

## 2. 控制转移

| 事件 | 必须执行的写入 | 后续行为 |
|---|---|---|
| 正式询盘首次接收 | 稳定根task＋来源待核验；通过后才启用确认、准备、联系人同步 | 重放不得新增根task或确认 |
| Sales生成新固定版本 | version递增；旧version superseded；批准失效 | 新版通知人工 |
| 改稿/来源有效修订 | task_revision／context_epoch递增；撤销未消费批准 | 新run生成新版本，保留旧成果 |
| 观察到相关新来信 | context_epoch递增；task_revision同步推进；未提交发送的旧批准失效 | 通知负责人；第一期不默认自动回复 |
| pause | 原子改paused、task_revision递增并撤销批准 | 不再开始外部动作；后台run结果可留档但不覆盖新版 |
| takeover | 立即改takeover_requested、task_revision递增、撤销批准、取消待提交发送 | 先对账dispatching/send_unknown；结果明确再human_owned并允许人发送。等待时只读查看、明确暂勿手动发送 |
| resume | 指定负责人授权后agent_active，task_revision递增 | 不复活旧批准；需要重新准备或明确批准当前有效版 |
| source业务被后台操作人关闭 | 把该source后续销售准备置暂停/需人工确认 | 保留询盘事实；不因此自动给买家发结束邮件 |
| provider人工发出对应邮件 | 关联外部发送事实；停止该待发送操作 | 不补发；归属不明则人工匹配 |

有权人的pause/takeover针对同一任务最新状态生效，不因旧页面revision冲突而失效；批准/恢复/改稿仍严格校验版本。

任务控制版本与客户绑定版本分别比较；批准必须绑定当前两者和context_epoch。旧schema升级和实际事务门禁尚未实施。

“人优先”落实在同一后端的事务顺序和epoch检查，不靠比较群消息先后。暂停先于发送提交点持久化时，网关拒发；若provider请求已经提交，不能保证撤回。尚未被回调/补扫观察到的外部新来信，也不能声称会瞬时阻止发送。

## 3. 发送的唯一受控入口

```text
操作者批准固定版本
  → 事务校验操作人、当前版本/epoch、未暂停、联系资格
  → 创建唯一 send_operation；写入待执行outbox
  → worker认领，重新检查授权、快照和附件
  → 原子取得dispatch资格并记录固定payload hash/idempotency key
  → 发给Resend（外部不可逆边界）
  → 记录provider ID及accepted；之后用事件/查询对账
```

发送槽唯一键：`(client_id, logical_message_id)`。同一首封跟进在所有改稿版本间保持同一个logical_message_id；回复槽绑定目标入站邮件及明确回复任务。purpose区分acknowledgment/first_followup/reply/maintenance_campaign，但不能仅凭新版本产生新的发送槽。确认信槽从原始询盘业务身份＋acknowledgment固定生成。

一个槽只有一个逻辑send_operation，已accepted/delivered或结果未知时不能因改稿再发。每次实际发送尝试有固定send_attempt_id、payload hash、snapshot_version和幂等键。只有前次被明确证明未提交/未被接受时才可准备新attempt；旧attempt被fence掉，排队旧消息不能继续执行。超时未知仍用同attempt重试/对账，不改payload或换键。确实需要更正/下一封跟进时，人明确创建新逻辑邮件并重审，不能用改稿绕过已发限制。

本地事务能保护自己的命令竞争，不能跨Resend原生UI建立分布式事务。不在持锁数据库事务中长时间等待HTTP。发送资格提交后立刻检查取消信号以缩短窗口，但承诺仍限定“提交点之前能阻止”。收到取消时若已dispatching，展示“正在确认发送结果”，不谎称已停发。

HTTP超时、连接断开或进程在provider接受后崩溃，均进入send_unknown。使用相同Resend幂等键和同payload可在官方24小时窗口内重试；本地记录长期保留。超过该窗口仍未知时，先查事件/发送记录及人工对账，不换键重发。不能把至少一次outbox等同邮件exactly-once。

## 4. 可编辑草稿与精确批准

Resend草稿是工作副本，内部MailSnapshot是审核和自动发送的依据。首封信发送固定from/to/subject/html/text/附件bytes，回复使用固定目标email ID及reply API。回复实际To由provider目标邮件的Reply-To/sender等决定，创建审核版本时即解析展示；主To变化要重新选择显式发送路径和重新批准。

原生草稿的created/updated/sent/deleted通知用于对账。先关联我方操作ID/外部对象映射并重读内容：我方已登记写入的回执或等价内容不当成再次改稿，迟到旧通知不覆盖新版；非预期的内容变化才触发接管/复核并使相关批准失效。人工改动视为接管/待复核，先停止自动覆盖；不能用“GET草稿hash匹配，再send draft”证明原子一致。reply draft的create不是普通完整upsert，已有未发draft时必须按官方update合同处理。

已批准发送成功后，要清理或标记对应工作草稿，清理失败告警且不重复发送。若系统无法可信判定原生草稿与固定版本一致，通知客户查看固定审核页；不把外部可变页面当作已批准版本的唯一展示。

## 5. 回调、修订和恢复

Resend验签后按connection＋svix-id去重，先持久化再确认；Apollo按自己的连接认证机制处理。provider事件旧到达不能回退accepted到queued，或把human_owned变回agent_active。映射不明的inbox/thread/contact暂存待匹配，不按email后缀猜客户。

Channel原库与Hermes库之间没有共同事务。保存后HTTP通知只是低延迟提示；补偿扫描以最终有效业务记录为准，重放稳定业务键。OEM附件激活失败并回滚的记录不得被扫描为可发送询盘。定期完整核对弥补时间游标/通知遗漏；历史数据默认不自动发确认，接入时固定`cutover_at`和显式回补策略。

停用新路径时先暂停消费者和外发开关，处理dispatching/send_unknown，再决定旧路径是否恢复。不可直接开回旧SMTP并补发全部“未标成功”记录。

## 6. 必须验收的竞争

- 两个入口同时批准，同一逻辑邮件只得到一个发送操作。
- v2批准后生成v3，v2不能发送；v2已发送后，v3不能再占同一首封跟进槽。
- 旧页面点暂停仍停最新任务；接管遇send_unknown先对账，不移交第二条发送通路。
- test_sending检查所有实际To/CC/BCC，包括固定确认信，不以重写真实买家地址替代测试任务。
- 暂停先提交，发送认领失败；发送已提交后暂停，界面显示正确边界。
- 新来信先被系统观察，旧批准失效；晚到事件保留接收延迟证据。
- A客户task搭配B客户凭据、附件或inbox，全部拒绝且无外发。
- provider接受后HTTP超时，重试不新增邮件；超过24小时转人工对账。
- 人工接管后Resend编辑/发送，Agent不覆盖、不补发；绕过接管的并发限制有明确说明。
- 旧确认路径和新路径开关不能同时有效；切换窗口未迁移询盘有可恢复记录。
