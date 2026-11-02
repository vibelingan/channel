# SG3.2：自动消费与真实模型接线实施计划

2026-10-29。继续当前 Sales 分支，不新增对外模块编号。目标是官网询盘被 Hermes 接收后，后台自动领取、核验来源、调用真实模型、读取获准资料并归档待审核成果。不部署、不发真实邮件，不修改其他 Agent、定价、SEO 或待批准 UI。

## 已有能力与本轮缺口

现有 `service.py` 只有 serve／dispatch／install；Dispatcher 的受理回执不等于已执行准备。原纵向测试由可信测试宿主显式调用来源授权和 PreparationWorker。本轮用真正的消费者替掉这段手工编排。

继续复用 Intake、SourceAuthorization、ChannelReader、PreparationWorker、MySQLRunLock、PipelineArchive 和既有失败／重试规则。模型只返回 `product.read` 或结构化 `draft` 计划，系统实际执行工具、核对事实、渲染正文和留档。现有正文是受控模板，本轮不把它宣传成模型自由创作全文；模型实际负责需求分析、查产品决策、缺项和内部跟进建议。

通用 AIAgent 启动会带入共享配置和工具，不直接注册到 Sales。复用无会话模型客户端与已有鉴权材料，不继承 shell、web、文件系统、发送或审批工具。

## 自动消费者

新增 `consumer.py`，服务入口补 `consume-once` 和 `consume`。必须同时显式启用 Sales 及准备开关，默认不启动；已有 serve／dispatch 行为不因缺少模型配置而改变。

消费者只从专用 MySQL 取当前 accepted run：存在接收记录，所属客户／业务／网站／环境和 run scope 一致，事件摘要与保存事实一致。任务 ID、run、收件人和附件范围均从服务器保存内容取得，不接受模型或 CLI 注入业务对象。

新增 `sales_consumer_jobs` 持久记录领取身份、有效期、尝试／失败次数、下次时间、完成或待处理状态。只扫描未完成的当前任务，过期领取可恢复；旧 run、失败任务和已完成历史不占活跃队列。首次发现当前 accepted run 时创建 job，无须改 Dispatcher 或原接收协议。数据库安装仍是单独显式操作，正常启动不运行 DDL。

每次领取使用短事务；授权、Channel HTTP、模型和文件准备均在事务外。短期 job claim 负责队列状态，既有 MySQLRunLock 负责同 run 的实际准备，二者职责分开：

- claim 到期不强行使仍持有 run 锁且任务权限有效的旧准备变成失败。
- 旧执行可以在既有 run 锁和权限仍有效时完成合法归档，但不能覆盖新 claimant 的 job 状态。
- 新 claimant 遇到 run 锁 busy 不启动模型；已有归档时先恢复，不能为恢复先申请来源授权或重新生成。
- 结果和失败仍由原 worker 的同一连接锁保护；队列完成／重试由当前 claim 比较后提交。

job 失败计数和普通 busy 分开，不能因另一个工作进程忙就耗尽模型失败预算。临时来源失败按有限退避重试，达到上限留 requires_attention，不绕过门禁。

## 真实模型适配器

模型方新增 ModelPlanner 及受控调用子进程，保留 `next_turn(request)`。每个 run 创建独立实例，不共享会话或 messages 历史；固定 provider、endpoint、model、鉴权来源和截止时间来自服务器配置。

优先复用已安装的纯 OpenAI 客户端。支持明确配置的 OpenAI-compatible endpoint；当前真实合成验收可显式选择 Codex Responses 路径，仅读服务器固定认证文件的当前 access token，不调用刷新／凭据池 resolver，不写原缓存，不自动切换账号。现有 CodexAuxiliaryClient 会丢失部分未完成状态，不能直接把它的 stop 当成功；必须看到明确 completed，拒绝 failed／incomplete／断流、拒绝和任何真实 API 工具调用。

调用子进程只执行固定的客户端代码，不是通用 Agent。子进程环境使用最小白名单，不继承 Channel、任务授权、发送或数据库凭据；模型凭据只用于认证头，不进入 prompt／结果／日志。请求正文只有获准业务资料和规则，不能选择 URL、身份或工具。

固定 HTTPS 端点，只有显式测试允许 loopback HTTP；禁环境代理和重定向。使用有界输入、输出、tokens（供应商支持时）和零 SDK 自动重试。父进程按剩余预算终止自己的调用子进程并回收，不能仅靠 socket timeout 声称有绝对任务时限。请求已送到供应商后终止客户端，并不能证明供应商不再计费。

模型错误分成可重试的服务不可用／超时和不可重试的认证、非法输出／工具请求。原 worker 小幅扩展：消费者显式允许且未达到失败上限时，可重试的模型异常不先把任务永久标失败；最后一次或非重试错误，仍在 run 锁下使用既有失败记录。默认行为保持原样。

任务准备总预算限制在短期来源授权有效期内，默认 180 秒、上限 240 秒；不以无限续期掩盖长任务。每次模型调用使用剩余预算，不能每一轮重新获得完整任务时间。

## 系统固定的成果身份

可信宿主从 current task 和 grant 组装 PipelineTask。submission ID 和逻辑邮件 ID 根据客户／任务／run 稳定生成；发件人从服务器配置且必须在当前绑定允许列表内，收件人只能来自正式询盘。cc／bcc 固定为空，回复地址和主题由宿主配置，模型不能修改。

附件只可从这条已授权来源中选；未知 MIME 不自动外发。没有可信 SKU 的 OEM 先准备澄清，不能把编造的 ID 当搜索结果。单品已有 ID 可以读取实时批准产品。无真实发送 sink，send_authority 保持 none。

完整归档后再写 job 完成；如果写完成回执失败，重启从原成果恢复，模型调用数不得增加。模型已返回但尚未归档就崩溃时，现有系统不能承诺零额外模型计费，报告明确保留此窗口。

## 写入分工

| 工作 | 文件范围 |
|---|---|
| 消费者与服务接线 | consumer.py、consumer store／schema／迁移、service.py、worker.py 的有限可重试错误处理、必要的归档恢复 helper、focused tests |
| 模型客户端 | model_planner.py、固定调用子进程、窄错误类型／只读鉴权 helper、模型 adapter tests、必要的依赖 pin；不碰 service.py／consumer.py |
| 纵向验收 | 新 consumer E2E、共用网站与假 HTTP 模型机械 fixture、原运行器新 suite／hash、结构化证据 |
| 复核与交付 | 两仓 SG3.2 文档和状态、fresh review、定向缺陷注入、受影响回归、远端 CI、提交推送 |

所有工程问题自行解决；真实认证若失效，先完成实现与其余验收，再明确只缺用户哪一步。不得打印或要求在聊天发送密钥。

## 验收

1. 实际 consume-once 从数据库发现任务，自动 grant／read／model／prepare／archive；测试不手工构造 PipelineTask 或调用 worker 补链。
2. 两个消费者和重复通知不产生并发模型准备；claim 到期、旧 owner 成功／失败、进程重启均不覆盖新状态。
3. 保存成果后 job ack 失败，重启恢复同一成果且零新增模型调用。
4. 错客户、旧 run、撤权、畸形事件和模型提示注入不能扩大工具、修改收件人或发邮件。
5. 假 HTTP 模型验证多轮、非法计划、超时、超大响应、代理／跳转和严格 completed；超时进程被回收。
6. 可重试错误有限退避，永久错误／耗尽预算有持久失败或 requires_attention，不能静默循环耗费模型。
7. 真实模型验收只用合成询盘、显式现有模型和只读 access snapshot，记录成功状态与非敏感摘要，不记录认证或完整 provider 响应；不调用真实邮箱。
8. 回归旧来源授权、官网可靠接入及准备／归档；重要 guard 做定向缺陷注入，保留首次失败。真实 CloudBase、线上 Infra 和真实邮件仍分别验收，不能以本地替身替代。
