# SG0.3 共同任务读取协议

2026-10-28。D1首个补齐单元，Channel销售分支实现；仅新增Sales专用合同和确定性判断，不改变其他Agent。部署、任务存储、lease签发和真实服务认证不在这一纯协议单元内。

## 已完成

- 新增sales-auth/1的SourceHandoff、TaskReadLease、TaskReadRequest、TaskAuthority、TaskPermit五种schema，生成TS类型；六种旧业务schema字节保持不变。
- TS authorizeTaskRead／Python authorize_task_read检查客户、环境、连接、runtime、task/run、客户及任务控制版本、来源版本、动作、附件范围、批准产品资料集、到期和撤销。
- 在线permit绑定整个规范化请求摘要，最长10秒；lease最长300秒。许可判断不调用模型，但输入必须由调用方从可信存储／认证传输取得。
- issueTaskPermit／issue_task_permit要求来源已核验、当前run/revision且任务可准备。该函数不是已经部署的Hermes控制接口。

## RED → GREEN 与复核

第一轮RED：新行为测试导入task-access.ts时缺实现，观察到ERR_MODULE_NOT_FOUND；随后实现。定向复核发现ID允许内部路径字符，补测试`task ids cannot encode paths even when every record agrees`，使用`task/../other_task`观察到Missing expected exception；收紧task/run的schema后GREEN。原来的`../`开头已会拒绝，未把那次通过伪称为失败证据。

读取并复核：新五种schema、生成类型、TS/Python policy、两端test/conformance、旧access/index/canonical及原58项vectors。重点检查请求摘要覆盖资源参数、同客户不同询盘、旧run／revision、撤权、错误audience、数据类型和客户凭据不能代替任务授权。没有独立第三方安全审查报告。

## 本地结果

- TypeScript包完整测试66通过，0失败；typecheck和generated检查通过。
- Python 8个测试方法通过，其中共享42个授权向量和当前任务状态反例；TS/Python授权42项结果一致。
- 原58项schema／strict JSON／canonical hash双语言一致。
- 现有sales-integration 15项回归通过；本单元未改它的运行代码。
- Python新文件black格式及pyflakes通过，git diff --check通过。

首次原58项parity用Hermes的Python环境执行时，invalid_date在Python错误放行。核对后该环境缺少契约requirements要求的format-nongpl依赖。改用本销售包独立忽略的.venv、按原requirements安装后58项全部通过；未修改旧日期规则，也未改其他项目依赖来掩盖问题。

## 使用边界

authorizeTaskRead只做数据和策略判断。不能把LLM提供的lease/authority/permit直接送进去当身份验证。SG1.3必须加载真实Channel记录、验证固定Hermes连接，并对读取前后重新查状态。当前仍未增加来源producer、可靠来源核验、真实模型循环或邮件发送能力。

远端：Channel 8b25f228的[Sales contracts 40627274084](https://github.com/vibelingan/channel/actions/runs/40627274084)成功；随后Hermes固定消费同版本，40fbac5的[Sales runtime 40627523609](https://github.com/vibelingan/hermesinfra/actions/runs/40627523609)成功，含既有MySQL与Docker隔离回归。Hermes本地73个方法，62通过、11因本地没有MySQL/Docker执行条件跳过；远端专用job实际执行。没有修改全局Agent或旧文章代码。
