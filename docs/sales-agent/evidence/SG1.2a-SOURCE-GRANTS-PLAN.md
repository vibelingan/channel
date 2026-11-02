# SG1.2a：可信来源核验与任务读取授权

2026-10-29。继续现有两条 Sales 分支。用户已恢复提交／推送授权；每个验证完成的自有增量及时推远端，不改未批准 UI、不部署、不发送邮件。上一轮 Hermes 6527059、Channel aa4104ae 已推送，Hermes 对应 CI 40850225676 通过。

## 先解决什么

当前任务收到后只能等待：普通资料接口要求已有任务许可，不能反过来承担第一次来源核验。本单元增加独立的服务器授权入口。Channel 重读实际记录并签发短时读取凭据；Hermes 从自己的任务库确认任务仍有效，再激活准备权限。模型不参与身份判断。

本单元不加入表单 hook、补扫、旧记录归属补录、OEM 最终完成标记或实际模型运行。现有落盘路径尚未写三项来源归属，OEM 也缺最终标记；没有这些证明的真实旧行继续拒绝，不能用测试 fixture 宣称官网已经自动接入。后续按保存路径和通知流程单独实施。

## MIU：避免首次核验循环与旧结果复活任务

### 当前代码问题

```ts
// 现有私有读取必须先有 lease 和 Hermes 当前许可。
return tasks.execute(grant, headers, target, readInquiry);
```

因此首次授权必须走单独的后台入口，不能放宽正常读取门禁。另一个危险场景是 Channel 返回结果时，Hermes 已经暂停、失败或切换运行；只按 task_id 更新会恢复旧任务。

### 请求与回复

Channel 路径固定为 `/integrations/sales/source-grants`，仅后台 POST。独立 `SALES_SOURCE_GRANT_TOKEN` 不能与运行读取凭据或已有许可查询凭据相同；只在明确开关下提供，默认不可用。

请求严格包含以下字段，不接受其他字段：

```text
protocol='sales-auth/1', request_id=32位小写hex,
client_id, business_line, source_installation_id, environment,
runtime_id, control_epoch, task_id=十进制字符串, run_id=32位hex,
task_revision=正安全整数, connection_id, lease_sha256, event
```

回复严格为 `{protocol, request_id, handoff, lease}`。复用既有 SourceHandoff／TaskReadLease 合同。Hermes 生成随机 32 bytes token，只传其 SHA-256；Channel 不接收明文 token。有效期由服务器固定为 300 秒，不由请求选择动作、目录范围或到期时间。运行连接必须当前有效，具备询盘／产品读取动作；附件仅限本来源。

### Channel 的确定性核验

1. 校验固定客户／业务／安装／环境、安装登记、当前绑定、epoch 及运行连接。
2. 重用 readInquiry，从已有明确归属字段的原记录重建规范事件；产品终态拒绝，OEM 还必须有最终标记和相符来源版本。只忽略 transport event_id，其余事实须与已保存事件一致。
3. 规范事件的摘要取 OEM category 或单品 brief，缺少时用固定说明；数量仅在原文为正整数且不超过 1e9 时提取。单品 snapshot ref 使用实际提交快照的 hash。
4. 同一 node-sdk 事务里先读原记录／附件元数据、安装、绑定、旧交接及旧授权，再写交接、lease 和请求身份。不在事务里调用 HTTP。撤销交接不能被重试写回 ready；重复 hash 不得换任务／请求，过期后必须新 token。
5. 新记录保留现有 `{record}` 包装，正常读取端直接消费。默认关闭，原读取路由和其他 Agent 权限不变。

### Hermes 的确定性核验

只提供可信宿主调用方法，不增加接收 source_verified=true 的 HTTP 写入口。独立来源激活凭据与 source/runtime/read-control 及 Channel grant 凭据分开，默认关闭。

先在短事务读取自己保存的事件、当前 accepted run/inbox、assignment、scope、revision 和授权状态；未核验 waiting 可首次授权，已核验 preparing 可续期。暂停、人工拥有、终态、旧 run 或来源不一致拒绝。释放事务后调用固定 HTTPS Channel client（测试仅允许显式 loopback HTTP），不允许重定向、环境代理或模型选择地址。

回复必须对应本次随机 token 摘要、请求身份、当前 task/run/revision、原来源和连接；在第二个事务重新核对原状态摘要和当前绑定，全部相同且凭据未过期，才保存已核验的 preparing 权限。网络失败或比较失败不激活任务。初始 revision 0 升至 1；重试 run 已有正 revision 则保留；续期不恢复暂停或失败。

返回给可信宿主的 grant 对象持有短时 token，默认 repr／公开摘要不含它。宿主可据此构造既有 ChannelReader；明文不落数据库、不进模型或日志。

### 复用、边界与验证

复用已有严格 JSON、合同、Boundary、Intake 事务与当前任务检查、Channel readInquiry、node-sdk 事务和既有资料门禁。事件 attachment_refs 从 200 对齐为现有 lease/reader 的 1800，并补真实长度的跨语言样例；不改其他合同含义。

先写失败测试，再实现；独立复查后跑实际 Channel HTTP＋Hermes MySQL 串行 E2E。关键反例：错误后台凭据、runtime 凭据冒用、跨客户／任务、未归属／未完成 OEM、已撤销交接、token hash 重用、过期／错误收据、网络失败、网络往返期间切换 run／暂停／撤权。测试不得手工 SQL 把来源改为已核验来证明本单元成功。对主要新门禁做定向缺陷注入。

### SDK 依据

Context7 当前未提供。已读 CloudBase 技能／项目 SDK gate，使用 CloudBase 官方 `/database/transaction` 文档并检查已安装 node-sdk 3.17.2／database 1.4.3。实际 runTransaction 返回回调结果，doc.set 使用不带 _id 的扁平数据；事务回调可能重试。实施沿用现有 NodeSdkDatabase 类型和已安装方法，不扩充 wx-server-sdk shim；运行项目 SDK 验证、构建和冷启动检查。

### 未选方案

不使用普通资料接口做首次核验，不接受模型或 HTTP 声明来源已验证，不用仅 active 安装登记给旧行补归属，不把外部网络放进数据库事务，不以过期 lease 自动恢复暂停任务。
