# 分模块实施记录

2026-10-30 最新 SG3.2：Hermes 自动消费与真实模型接线已完成开发、独立复核和合成验收，跨仓库及真实模型 62 项通过；代码 `05b17224` 已推送。未部署或发送邮件。见[本轮交付](evidence/SG3.2-AUTOMATIC-EXECUTION-REPORT.md)。下面较早日期的记录保留其当时状态。

2026-10-29 SG3.2：可调用准备模块完成本地实现、分轮复核与 14 项真实 HTTP/MySQL 模块端到端；50 项针对性、15 项旧归档回归和 19 项定向缺陷注入通过。实际内容模型、自动触发和发送仍未接通，见[本轮交接](evidence/SG3.2-PREPARATION-HANDOFF.md)。本轮未提交、推送或部署。

2026-10-29：SG3.1离线销售准备模块已有代码与验证，23项针对性及8样例通过，见[本轮交接](evidence/SG3.1-PREPARATION-HANDOFF.md)。不代表已接真实模型、询盘自动生成或邮件发送；企微交互仍只做设计，暂停/接管后置。

2026-10-29 补充：SG2.3 成果归档切片已有实现及本地验证，完整模块仍部分完成，生产新 run 与重试调度未接入。见[本轮归档交接](evidence/SG2.3-ARCHIVE-HANDOFF.md)。官网与企微控制只交付设计样稿，未改交互运行逻辑。

## SG0.1 共同合同与假服务

状态：离线实现与验证完成。设计文档提交77876aeb已先推送origin/feat/sales-agent-modular-design。本单元不连接客户账号，不开放HTTP路由，不实现SG0.2授权。

### 当前问题和数据归属

现有inquiry.schema.json只用于设计检查，TypeScript/Python还不能共用运行合同。现有AI聊天DTO与金额canonicalNumber处理不同业务，不能拿来校验销售草稿或精确批准摘要。

```ts
// 当前只有设计schema与文档类型；没有sales运行校验入口。
// 目标：先校验安全JSON，再按唯一schema校验，返回类型和数据副本。
const inquiry = parseContract('inquiry', rawJson);
const digest = hashCanonicalJson(immutableSnapshot);
```

数据均为合成fixture；schema按1.0固定，真实客户数据、长期任务存储和授权不在此单元。输入限定安全整数、合法Unicode和有限大小/深度，拒绝重复JSON key，防止两种语言看到不同内容。

### 选择及技术限制

复用已有询盘schema及样例，将唯一运行源放入sales-contracts；文档引用该源。TypeScript使用Ajv2020，Python使用jsonschema读取同一schema；TypeScript类型由schema生成并检查漂移。精准摘要使用逐字段序列化，不能先排序对象再JSON.stringify，因为整数形key会被再次重排。

无网络的fake只模拟草稿、接受和超时。实例内同key重放/不同payload冲突用于恢复测试，不代表生产鉴权、持久化或全局一次发送。不能复用现有SMTP包作为fake。

### 测试和执行

先加入拒绝未知版本、沿用询盘、重复key/unsafe数、Unicode/整数key排序和非JSON对象的用例。最初执行因缺少tsx路径而失败，不能把它算作业务断言已观察到RED；完成后通过两次故意破坏校验来证明测试能捕捉对应错误。

### 验证结论

SG0.1离线实现完成。9个TS测试、6个Python测试、54个共享一致性样例、typecheck和生成类型检查通过；两处故意破坏校验均被测试捕捉，修复后重跑。详见[evidence/SG0.1-VALIDATION.md](evidence/SG0.1-VALIDATION.md)。这不是SG0.2授权、真实投递或部署验证。

提交595a48495033b538d6393def52f8c2294a4325bc已推送origin/feat/sales-agent-modular-design，远端[contracts工作流](https://github.com/vibelingan/channel/actions/runs/39882624469)成功，headSha一致。本单元通过后才开始SG1.0。

## SG1.0 询盘源码核对

状态：指定提交的源码审计完成；未修改官网业务实现。开始于595a4849，范围仅为路由、开关、落盘、后台、附件完成条件及复用选择。

### 选择与后续影响

选main 404d1a25为后续Channel实现参考、Phase 2 a7e16aa2为客服设计参考。正式单品询盘来源dbf802b2已同时在两者中；两者各有独有提交，不能将Phase 2当主线超集。销售worktree仍保留原起点，本轮没有merge、rebase或复制产品代码。

查明首页/OEM走真实submitProject，正式单品走public quote事务及专用后台；旧modal的模拟代码存在不代表当前正式目录仍用它。客服Phase 2预填尚未实现。OEM项目先保存、storage附件后激活且回滚可能失败，不能仅凭项目行存在就补扫派发。详细依据见[SG1.0-BASELINE](evidence/SG1.0-BASELINE.md)。

### 检查及可重复证据

新增源码清单固定44份文件、7组覆盖和80处行标记；check_source_snapshot.py核对Git对象、哈希、行号、共同祖先及6份跨分支相同文件。它只检查源码身份，业务结论另经跨文件只读复核。未运行该固定主线的产品测试，未读线上配置及客户数据。

本轮实际审阅SG1.0-BASELINE、modules/SG1-channel、GAP-AND-REUSE、README、handoff及两份实施证据。具体措辞修正：把“较新Phase 2有正式单品询盘”改为“main和Phase 2均已具备”，把“走通”明确为“指定提交的源码接线核对”，避免暗示已完成线上测试。核对了提交关系、正式/legacy调用链、OEM激活顺序、后台不发邮件提示及两个后端开关。

独立只读复核另指出两处表述过宽，已按main handler:1120,1145-1158,1169-1170改正：旧inline只推导MIME而非同等类型匹配拒绝；OEM仅存Number转换结果，不能承诺恢复数量原文。复核者独立运行源码检查通过，未修改文件。

SG1.0是源码审计，没有新增产品行为，不对生产代码进行RED/GREEN或声称旧产品测试已执行。通过范围为源码清单、文档及schema检查；最终命令和结果记录在SG1.0证据中。其余21个单元保持未实现，SG1.1仍依赖SG0.2授权及选定主线整合。

最终检查通过：源码44份/80处/7组、6份跨分支同源；23单元DAG、文档链接、原稿哈希及schema样例通过；临时篡改源码哈希被检查器拒绝。具体命令和结果见[SG1.0-validation.json](evidence/SG1.0-validation.json)。原Channel与Hermes分支、本地HEAD及既有未提交文件保持原样；本轮仅更新销售目录中的文档和核对脚本。

## SG0.2 客户连接及动作授权

本轮实施计划797eaac2已先推远端。新增服务器registry schema和access库，复用SG0.1校验、JSON规范及类型生成，无新增依赖。客户绑定、连接凭据、actor动作及每次调用的范围检查集中在一个入口；公开客服和既有管理员会话不变。

当前代码只有元数据校验，不能用`validateContract('run-context', input)`取得任何客户权限。新增路径为`access.execute(request, scopedOperation)`，由服务器加载最新配置和连接凭据，在操作前校验客户/业务/安装/runtime/环境/epoch；读取结果释放前再次检查。loaders属于可信后端，不把client_id和群名当认证。配置仅含credential refs，引用与外部账号真实归属需接入时验证。

复用方案的成本是每次读取授权配置，避免长期缓存放过撤权。未选择按模型prompt、公共客服角色或Partner Seat自动授权。控制停用不宣称撤回已接受的外部请求；发送回调只能用于权限前置验证，SG5精确批准及发送账未实现。

实际RED→GREEN：拒绝全部骨架下4个正向行为失败；实现允许路径后10项通过；新增publisher不能读取的反例先失败，补角色约束后12项通过。合同包21 TS/6 Python/58共享样例、生成类型、typecheck通过。查阅并核对access.ts、access.test.ts、client-bindings schema及包README；将“真实工具目标”改为“限定范围的工具目标”，明确测试仅为本地canary，不冒充真实平台联调。详见[SG0.2验证](evidence/SG0.2-VALIDATION.md)。

SG0.2原提交bf8e429b已推送，[远端检查39891019917](https://github.com/vibelingan/channel/actions/runs/39891019917)成功后开始SG1.1。

### 主线整合的处理

直接merge main仅有锁文件冲突，机械补回销售依赖后frozen install和21个合同测试通过；但提交检查将主线历史文档的绝对用户路径算入此次新增而阻止提交。未改历史文档或关闭检查，已abort本次merge；改从404d1a25建立feat/sales-agent-integration，仅cherry-pick我们自己的5个销售提交。原分支和远端记录保留。

当前与404d1a25的差异经NUL分隔路径检查，只有docs/sales-agent、packages/sales-contracts、独立sales CI及锁文件；其余产品文件逐字节匹配主线。锁文件保留main所有已有条目，只新增1个importer、11个package、11个snapshot，无其他依赖升级。后续SG1.1在此集成分支推进。

## SG1.1 询盘及资料读取

### 业务问题及数据边界

现有数据只能经管理员或公开目录处理，Hermes不能使用管理员token或任意集合查询。新增单客户、单业务、单安装的服务入口，继续使用原表和不可变产品快照。源码为apps/functions/sales-integration；其他产品/SEO/pricing实现不改写。

调用形状为`access.execute(authenticatedConnectionAndScope, grant => readBoundInstallation(grant))`，再以白名单输出contact、requirements、snapshot及私有附件ref。服务器绑定决定客户及安装；同客户另一业务、另一安装、撤销连接、旧epoch都不能借用当前入口。`source_revision`只散列提交资料，不因后台备注/状态再生成一次提交；API的200仅证明获权读取，不授予派发或发送。

### 技术选择与检查

旧OEM附件先存项目后激活，inline与storage元数据不同。当前仅交付active、正确purpose/owner、secret已清空、hash/大小/环境路径均可验证的storage文件。下载前后重读来源，先获得服务器私有URL，再在精确HTTPS host白名单内限时、限流式大小取bytes，拒绝redirect，校验bytes后返回；不把URL交给模型/浏览器。没有选择直接使用无大小上限的SDK内存下载或把旧文件一律当active。

选择独立HTTP Function及Nodejs20.19 bootstrap，保留既有Event Function部署清单。实际复用public-api getProductDetail和源schema，不重新计算价格；新接口按ID有界读取，列表补扫留SG1.2。SDK官方合同、已安装类型和pnpm verify:cloudbase-sdk核对通过；未加环境别名或SDK shim。

先执行404骨架，正常读取/认证/拒绝状态用例失败，再实现。新增错客户字段、同客户另一业务的反例分别观察到200而应404/403后修正；private-file骨架的正常读取和超限取消先失败，再实现流式限制。裸目录冷启动暴露import.meta schema读取错误，改为从唯一schema自动生成可内嵌数据后重跑成功。复用fixture移出test文件，避免重复计数。

补查SCF官方文档确认HTTP响应仍受6MB上限约束，新增4MiB有界Range传输。先观察到“请求Range却返回200”和“10MiB不分段也返回200”的两项失败，修复后通过；每段重新鉴权、校验完整源文件，10MiB合成文件三段拼回后逐字节相同。

最终相关6包565项回归、接口15项（已计入565）、Python 6项、跨语言58样例、typecheck/生成检查通过。loopback HTTP比较小文件、2MiB下载和10MiB分段附件；真实CloudBase网关和Hermes没有参与。已阅读并修订handler、sources、private-file、server、index、脚本、README与验证文档，把“真实测试”明确为“本地socket及合成附件测试”，另列[真实联调计划](evidence/LIVE-TEST-PLAN.md)。

### 工作区与兼容

内置盘反复ENOSPC后，备份未提交tracked patch，逐文件hash核对14份未提交源码，转外置盘独立检出继续同一分支；原副本保留，没有删除其他工作区或结束他人进程。check_design增加原Channel路径参数并继续核对相同受保护hash。

推送前再次fetch，最终固定pricing 27611ff6、SEO cd4df7e2，写入交集只有锁文件。四个关键产品/询盘接口相对最初333c0240不变；公共产品读取继续调用原函数，可选新增参数不破坏前7个参数。SEO后增文章发布任务和独立dummy adapter，没有改变本接口使用的读取签名。主线20个importer和754组package/snapshot条目完整保留。没有出现必须修改对方业务实现才能继续的冲突；未合入对方未完成代码。详细结论见[SG1.1验证](evidence/SG1.1-VALIDATION.md)。

## SG2.1／SG2.2 跨仓库交付

2026-10-24，Hermes独立worktree从main 52d0365开展，先推送说明，再依次完成客户运行边界和可靠接收。逐项代码、回滚/并发/身份反例和CI证据见[验证记录](evidence/SG2.1-SG2.2-VALIDATION.md)。最终Hermes代码2fbc50c、CI40065259862通过，旧共享调度和文章入口未改。Channel只更新销售文档和计划，不改pricing/SEO代码。

本轮实际阅读并复核Hermes registry、assignments、dispatcher、001_schema、全部sales_flow源码/测试及Channel合同、模块和交接；补出共用root、布尔值冒充整数和TLS反例后修正。明确写成“worker持久接收，等待SG3准备”，避免把受理回执描述为Agent已完成销售内容；修正旧交接中“SG0.2尚未完成”“main尚未整合”的过期说明。已说明OCR未配置模型导致独立审查未执行，未把自审冒充第三方review。


## 2026-10-26：设计修订，开发暂停

用户仅授权整理权限协议、Channel独立门禁、任务授权、真实工具接线及实时产品／留档设计。主文档为[SECURITY-AND-TOOLS-DESIGN.md](SECURITY-AND-TOOLS-DESIGN.md)，图和PDF随附。复用原连接认证、资料reader、Boundary与Dispatcher，缺口另列；本轮不实施、不改schema、不更新既有单元为完成。后续先由用户确认D1，再调整实施单元及依赖。文档验证与视觉记录见[VERIFICATION](evidence/VERIFICATION.md)。


## 2026-10-28 D1第一批补齐

SG0.3增加Sales专用授权合同与TS/Python确定性判断；Channel 8b25f228 CI40627274084、Hermes固定消费40fbac5 CI40627523609均成功。旧六种业务schema与其他Agent保持原样。随后SG1.3在Sales私有HTTP路径强制任务授权，验证见[SG1.3记录](evidence/SG1.3-VALIDATION.md)。本轮不改变客户线上配置、原询盘写入或邮件发送。

按humanizer复核README、函数说明与本轮证据，将“权限隔离已实现”明确为“Sales读取门禁已实现；来源签发、Hermes持久控制和真实运行接线未完成”。核对文件为共同task-access/schema/test、handler/task-gate/permit-client/index/sources及原Inquiry终态函数；状态和测试数字以实际日志／对应SHA为准。


## 2026-10-28 SG2.4：持久任务读取许可

Hermes 6b36a9d完成客户任务库授权接口、新任务默认等待状态、独立控制凭据、请求ID与摘要绑定。观察到路由404和三种assignment终态错误放行后修复；MySQL13项、实际Channel客户端联调1项通过。对应CI 40643073628成功，含原MySQL10项、Docker1项和dispatcher33项。Channel没有改运行代码；临时合成MySQL已移除。

actual review：Hermes authorization/intake/http/service/schema.sql、固定task_access policy、三个新test文件、旧intake/http/dispatcher tests，以及Channel permit-client。文案从“Sales已接通”收紧为“控制查询读取真实任务库；来源签发与实际模型工具仍待接入”。详细实现、风险、逐层验证及下一步见SG2.4-REPORT.md；它没有声称交付企微暂停按钮或完成线上隔离验收。
