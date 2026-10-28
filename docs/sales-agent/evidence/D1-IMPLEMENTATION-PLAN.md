# D1 权限补齐实施计划

> For agentic workers: use superpowers:executing-plans, implement and verify each unit before starting its dependent unit. No delegation in this workstream.

2026-10-28。用户已授权继续实现D1工程设计；不等于客户签约、账号接入或对外发送授权。

Goal：先交付可执行的Sales任务授权协议及Channel强制任务门禁。保持其他Agent和官网原业务不变。

Architecture：复用既有服务连接认证，再验证Channel保存的来源交接／任务授权及Hermes当前任务许可。共同规则归Hermes平台语义，唯一schema/双语言实现源继续放packages/sales-contracts。Channel读取没有任务授权就拒绝，不回退客户级密钥模式。

Tech Stack：现有Node/TypeScript、JSON Schema/AJV、Python/jsonschema；既有CloudBase SDK读文档和原有HTTP函数。

Spec：[D1设计](../SECURITY-AND-TOOLS-DESIGN.md)。当前Channel起点a44e5057，Hermes起点2fbc50c，均干净独立销售检出；不新建重复分支。

## 全局约束

- 只影响Sales专用包／HTTP函数／Hermes销售边界。原有询盘、审批1.0及其他Agent不批量升级。
- 新授权合同命名为sales-auth-*，protocol固定sales-auth/1；不知道的版本／字段／类型拒绝。
- control_epoch属客户连接，task_revision属任务安全状态；task/run跨服务使用字符串标识。
- 时间使用整数Unix秒：读取lease最长300秒，单次在线permit最长10秒；不以TTL替代当前状态检查。
- 现有查询默认读取当前批准产品；源询盘提交事实不改写。模型无凭据、DB/OSS或发送工具。
- 未实现可靠producer、来源核验和真实运行时，不声称官网已自动接入；live开关保持关闭，不连接真实账号。
- 每个单元先写失败测试，再实现／复核／完整相关回归，提交推送并核对该SHA远端检查；依赖通过才继续。

## Review Focus

1. 正确客户密钥搭配错误任务／run／资源，必须拒绝。
2. 类型混淆、字段注入、旧许可重放、过期／未来时间和返回前撤权，必须拒绝。
3. Channel安装历史行缺归属信息，不能继续无条件放行。
4. 在线任务检查失败，不能使用缓存正许可或直连数据库兜底。
5. 新授权能力不得开放邮件发送或改变旧Agent权限。

## SG0.3：共同任务读取协议和确定性检查

Files：packages/sales-contracts/schemas/sales-auth-*.schema.json、fixtures、src/task-access.ts、python/task_access.py、双语言test与conformance脚本；只追加新contract kinds，保留六种旧schema字节不变。

Interfaces：
- SourceHandoff：服务器登记的来源归属、原记录及版本、最终ready/revoked状态；存句柄摘要。
- TaskReadLease：客户/连接/runtime/environment/task/run/control_epoch/task_revision、source handoff摘要、允许动作和附件、approved_catalog范围、audience、签发／失效／撤销。
- TaskReadRequest：上述范围、授权摘要、request_id、动作及严格资源参数；不能只给task ID。
- TaskAuthority：从Hermes可信任务存储加载的当前范围/run/revision、来源核验与控制／工作状态。
- TaskPermit：绑定完整请求canonical hash和10秒时间窗的在线回执；只能经认证固定服务传入，不是自认证票据。
- authorizeTaskRead(lease,handoff,permit,request,now)／authorize_task_read：纯程序检查，不调用模型。
- issueTaskPermit(request,authority,now)／issue_task_permit：当前任务必须已核验且处于可准备状态才给许可；调用方另做服务认证及fresh binding。

- [x] 失败测试：合法请求可读；同客户错task、跨客户、错run、错连接、源版本变化、权限撤销、过期、参数hash变化、附件越界、非批准产品资料集等均拒绝。
- [x] 实现五种合同、生成类型和双语言判断；保留通用拒绝，不返回秘密。
- [x] 同一JSON授权向量在TS/Python结果一致；原58项canonical/schema样例及旧测试继续通过。
- [x] 复核并提交推送Channel；远端通过后，Hermes仅消费固定提交的新增合同／Python检查，不注册到全局Agent。

## SG1.3：Channel强制任务门禁

Files：apps/functions/sales-integration/src/{handler,sources,index}.ts及新增task-gate.ts、受限Hermes许可HTTP client和tests；更新销售函数README/独立CI，不改原表单、数据库公共模型或SDK类型。

Interfaces：SalesTaskGate在已有AccessGrant后取得可信lease/handoff记录，构造TaskReadRequest，向固定Hermes控制接口请求TaskPermit；操作前及返回前均fresh读取并验证。X-Sales-Task提供协议、task/run/revision/request_id；X-Sales-Lease提供随机短时句柄。凭据和句柄不进模型。

- [x] 失败测试：原来仅客户级密钥读取也应拒绝；同客户双询盘不能串读；错误lease/permit、在线超时、读取中撤权／修改版本、安装归属不明拒绝。
- [x] 接入所有私有读取路由，没有可选绕过模式；复用产品reader与附件Range/完整性检查。
- [x] 安装归属要求明确行归属，或fresh读取可核验的固定安装归属登记；未提供证明就拒绝legacy行。
- [x] loopback真实HTTP、打包冷启动、原受影响函数回归、CloudBase SDK contract gate和远端CI通过；记录未联调真实Hermes与客户账号。SG1.3代码ad3ab621，对应Sales contracts 40630655316成功。

## 后续依赖

Hermes任务库中的当前状态、Channel来源producer与lease签发、来源核验、task私有HOME以及完整模型工具循环仍分别归D1后续补齐和SG1.2/SG2/SG3。不得用本轮纯授权判断或合成HTTP测试冒充完整线上接线。批准／邮件外发模块保持原来未实现状态。

## MIU：客户连接不能代替任务授权

Runtime problem：当前handler只执行`access.execute({connection_id,bearer_token,scope,action}, read)`，同客户请求可传任意询盘ID；当前sources对缺归属字段旧行放行。

Data shape：服务密钥在服务器长期连接配置；lease随机句柄只留工具代理，存储只留SHA-256，最长300秒；request带固定task/run/revision和资源；permit仅绑定这次请求，最长10秒。

Constraint：schema只查形状；没有真实存储与认证HTTP来源不能把permit当可信；两端无共同事务，返回前重查和在途撤权语义必须保留。

Fix：旧连接认证继续执行，任务门禁在其后对所有Sales读取执行。模型只给有限业务参数；scope、lease、目的地址均由服务器注入。

Rejected：仅prompt隔离、只认客户密钥、长效自包含票且撤权靠到期、公共附件URL。

Risk/tests：同客户task1读task2、request_id复用换参数、读取期间撤权、旧API缺lease；以真实函数行为和跨语言向量核对，不增加空洞镜像测试。
