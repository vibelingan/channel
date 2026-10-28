# SG1.3 Channel强制任务门禁

2026-10-28。D1第二个补齐单元；只改Sales专用HTTP函数与其测试，不修改官网表单、后台原接口、pricing/SEO、数据库公共模型或其他Agent。

## 已接入的代码路径

- handler在原SalesAccessController认证后，所有询盘／产品／附件路由必须经过SalesTaskGate；没有可选的“仅客户密钥”兼容开关。
- 凭据解析只留服务器。X-Sales-Lease只接受32字节随机句柄的规范base64url，按解码bytes的SHA-256取服务端lease记录；X-Sales-Task严格检查协议、task/run、版本及请求身份。
- Channel独立核对固定安装与实际环境、lease/handoff、来源版本和附件范围。OEM必须有服务端最终完成标记，业务关闭／完成后不能继续准备。
- 固定Hermes控制URL使用独立服务器凭据、生产HTTPS、拒绝重定向、3秒截止、16KiB响应上限和严格JSON。请求摘要包含动作、实际资源参数及Range，模型提供的“批准”header无效。
- 本地记录在远端检查前后重读，业务来源在数据准备前后验证；最终再核对任务许可。等待中撤权、读取后暂停或晚到旧结果都不能返回准备好的内容。
- 原产品reader、提交快照和附件bytes／hash／Range继续复用；产品查询不传旧revision时读取当前批准资料。

## 先失败再修复与代码复核

初始两项真实handler反例为200→应403（缺任务授权）和200→应404（旧行缺明确归属），已观察到失败后实现。

本会话源代码复核又补三个反例并观察到原实现放行：

1. 后台已关闭询盘、Hermes仍显示准备中，200→应403；Channel复用现有询盘终态规则独立拒绝。
2. 产品资料已准备，后续来源复查时任务暂停，200→应403；把最终任务许可检查放到来源复查之后。
3. 最后一次远端许可等待期间lease撤销，200→应403；增加远端往返后本地记录重读和摘要一致性检查。

具体用例在task-gate.test.ts；上述三项及整个函数测试均要在最终版本通过。反例记录在本机验证日志，未声称由独立第三方审查完成。

## SDK与兼容核对

没有Context7工具。已读取项目SDK合同规范及CloudBase技能；官方文档检索、NoSQL OpenAPI获取成功。官方Node SDK主页面的Markdown不可取、网页读取超时，因此未把它记为已读。另直接核对安装的wx-server-sdk 4.0.2与@cloudbase/database 1.4.3：真实DocumentReference.get存在，普通单文档读取返回data数组；复用现有collection().doc().get()模式，没有发明SDK方法或修改.d.ts。

新授权记录从独立的channelSalesInstallations、channelSalesTaskLeases、channelSalesSourceHandoffs读取，业务值放record字段。CloudBase code-review按实际Node服务场景核对：这不是Web用户登录，不变更Auth provider／安全规则；特权数据留在服务器，原始SDK返回不直接给模型。完整SDK gate及冷启动检查作为最终验收项。

## 本地与远端验证

本单元最终定向验证覆盖32项接口／控制HTTP测试，包括真实loopback认证调用、超时、重定向、重复JSON键、超大响应、客户／任务／run替换、读取中撤权、附件分段与完整性、来源终态和实时产品查询。

首次全仓库运行因本检出缺AI包依赖而停止；按锁文件在本独立检出补齐，pnpm-lock.yaml未改。使用本机Node25再跑时，既有网站测试因localStorage行为不匹配失败；改用Sales CI同版本Node22.13验证，没有修改网站代码规避。Node22.13下完整pnpm test成功；具体pass／skip统计见下方最终汇总。

最终补充：函数typecheck、SDK gate、构建／独立打包／不依赖工作区和schema侧文件的冷启动均通过；原58项与新增42项双语言parity、Python8个方法通过。两个销售检出和四份受保护原稿的边界核对完成，pnpm-lock.yaml、原官网/产品业务代码及Hermes全局Agent未改。远端状态在推送对应代码SHA后另核对。

## 尚未实施／上线的部分

此单元消费服务端授权记录，不提供公开签发接口，也不自行创建生产集合。真实来源producer、归属回填／映射、OEM完成标记写入、lease签发，以及Hermes认证控制接口的持久任务状态读取均仍待下一阶段。现在启用但缺记录／接口会拒绝读取；正常部署开关仍关闭。模型循环、企微批准与Resend外发没有因此自动完成。

其他Agent不使用这套Sales协议，不改全局Hub、文章流或其权限。已经返回的数据不可收回；跨服务复查不是分布式原子撤权或“绝对安全”证明。真实Infra联调按LIVE-TEST-PLAN单独验收，不把本轮测试称为线上验收。


## 最终本地汇总

Node22.13运行完整pnpm test：2,863项，2,860通过、0失败、3项原有跳过（ai-engine两项、site一项）。其中Sales接口32项全部通过，共同合同66项全部通过。部署脚本测试、共享数据、导入、产品／后台／网站及本地服务测试均完成；这些是本地回归，不是执行真实部署。

Python8个测试方法、原58项与新42项parity、函数typecheck、SDK gate、Node22打包冷启动均通过。git diff --check通过；原pnpm锁文件未变。受保护原稿hash匹配；规划检查覆盖原23项加2个补齐项，无循环。
