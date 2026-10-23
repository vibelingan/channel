# SG1.1 受控询盘、产品及附件读取

2026-10-23。源码位于apps/functions/sales-integration。SG0.2原提交bf8e429b的远端检查成功后才开始本单元；当前以main 404d1a25为起点的feat/sales-agent-integration继续，原设计分支保留。

## 实现与复用

新增独立私有HTTP入口，调用SG0.2认证及动作授权。每个服务固定客户、业务、安装和CloudBase环境；即使凭据在同一客户下也获准其他业务，它仍不能把cold_outreach上下文用于官网询盘入口。响应带服务器核对后的owner_scope。

OEM、单品分别读取原有oemProjects和catalogQuoteRequests，不迁表、不改提交表单或保存函数。使用已有InquiryDetailSchema、文件大小常量、数据库/存储adapter；当前产品查询直接调用public-api的getProductDetail，不复制定价、批准或SKU分页逻辑。私有产品字段不通过原始数据库spread输出；保存的询盘snapshot不拿当前产品覆盖。状态或备注改变不改变提交资料的source_revision。

附件仅支持现有正式OEM storage上传。必须active、purpose匹配、ownerProjectId相同、上传secret已清空，大小、SHA、环境及storagePath均有效。临时存储URL只在服务端使用；配置精确host，拒绝非HTTPS、带用户名密码及重定向，边读边限制10MiB，再验证实际bytes和重读来源，返回强制下载的私有bytes。旧inline、pending/failed和跨归属附件均拒绝。单品现有表单没有附件字段，不虚构产品私有文件库。

读取成功不等于有资格自动派发。SG1.2的OEM最终完成标记、cutover、通知和补扫尚未实现；本轮不触发Sales任务，也不修改现有SMTP确认信路径。

## 运行及打包

使用独立HTTP Function而非既有Event Function的HTTP访问层，避免把较大私有附件塞进现有JSON响应路径。运行时Nodejs20.19、端口9000，独立打包为dist/package；不加入pricing、SEO或现有函数部署清单，不自动部署。

补查[SCF官方限制](https://cloud.tencent.com/document/product/583/56124)确认单次响应最多6MB，HTTP Function同样不能整包返回10MiB。已限制附件单次返回最多4MiB：大文件须用同一ref连续发送单段闭区间Range请求，逐段核对Content-Range，拼接后对照完整SHA。每段都重新鉴权、校验完整源文件；源资料变化即拒绝。未分段或请求段过大返回413，非法/多段/开放区间返回416。没有把“换成HTTP函数”当作绕过平台限制的方法。

裸目录冷启动发现SG0.1按import.meta.url读schema，在CJS bundle中会Invalid URL。已由同一JSON schema生成schemas.generated.ts，check:generated同时检查类型和内嵌schema漂移；没有手工维护另一份规则。临时目录仅放最终运行包，没有workspace、node_modules或schema sidecar，启动与默认关闭状态检查通过。

## 本地验证及复核

- 授权库、共享模型、数据库、存储、公开API、新接口6个包回归，共565项通过，0失败；其中授权库21项、新接口15项。
- 新接口本地HTTP完成认证、询盘读取和socket文件下载；核对2MiB合成附件及10MiB附件分段拼接后的全部bytes，并验证未分段、段过大和非法Range被拒绝。数据和凭据均为合成，未连客户服务。
- Python 6项、TS/Python 58个共同样例、双方类型检查及生成检查通过。
- pnpm verify:cloudbase-sdk通过；官方类型和已安装运行包仍为@cloudbase/node-sdk 3.17.2、wx-server-sdk 4.0.2，没有增加SDK shim。
- Context7不可用。按CloudBase skill查阅官方[存储合同](https://docs.cloudbase.net/api-reference/server/node-sdk/storage)和本地HTTP Function运行说明，核对downloadFile/getTempFileURL及Nodejs20.19 bootstrap路径；管理侧未登录，仅进行了文档查询，没有访问线上配置或客户记录。

计数、最终运行包hash和未执行的线上项目另存为[验证清单](SG1.1-validation.json)。运行包可重新构建，未把dist提交进仓库。

测试先观察骨架的404与期望200/401/403不符，再实现；补充“记录声明其他客户”“同客户另一业务不能借用官网接口”“私有流超限取消”的失败用例后修复并通过。打包曾成功但冷启动失败，修正内嵌schema后在裸目录再次通过。测试计数没有重复导入test文件：共用fixture已独立。

分段传输先增加反例，观察到Range仍返回200、10MiB整包也返回200的两项失败；实现4MiB响应限制后，两项通过。服务端暂不缓存完整附件，每一段均重新有界下载及校验；这是当前吞吐与完整性之间的取舍，真实联调须检查延迟及限流。

人工按CloudBase及simplify规则检查了handler、sources、private-file、server、index、打包脚本和access调用点：无Web登录替代、无任意集合/URL入口、无原始数据库返回、无客户secret/存储URL出参、无调用方指定身份授权。按humanizer复核README及交接，将“真实测试”改为明确的“本地HTTP及合成附件测试”，避免把它算作线上投递或平台联调。

## pricing／SEO与工作区

初次比较版本为pricing 333c0240、SEO cd4cd2b9；推送前重新读取远端，固定为pricing 27611ff6、SEO cd4df7e2。四个关键询盘/产品读取接口文件相对333c0240没有变化；pricing新增内容为浏览器测试及记录，SEO新增文章发布任务和独立dummy adapter，不改变本接口使用的读取签名。新增文件与两条工作流的业务写入范围不重叠，交集只有pnpm-lock.yaml，详见[兼容清单](SG1.1-compatibility.json)。主线20个importer和754组package/snapshot条目全部保留，仅增加销售自己的依赖及importer，不升级其他版本。pricing的getProductDetail保持已有前7个参数并追加可选参数，当前调用兼容；底层resolvePublicVersion及priceSummary改进继续由该模块维护。SEO的公开产品URL不作为销售记录身份，接口始终使用原记录及productId。这是固定提交的接口和写入范围核对，没有把未完成分支合并或冒充联合线上验收。

本机磁盘多次ENOSPC后，使用外置盘的独立检出继续同一分支，逐文件hash确认未提交源码副本一致。原销售检出保留为备份，不删除其他工作区；当前交付以外置盘检出及远端为准。检查脚本增加channel-source参数，仍核对原工作区4份受保护文档的原哈希，不跳过保护。

## 尚未验证的真实环境

未部署、未创建channelSalesBindings、未修改安全规则，未连接线上Hermes或发送邮件。上线前须证明该TCB_ENV只含绑定客户的数据；若旧记录来自多个客户且无归属，不能直接启用，应先补归属或隔离环境。独立HTTP网关、鉴权/限流、真实storage host和10MiB下载须实测，不能从本地socket成功推导出来。

真实验收安排见[本轮计划](SG0.2-SG1.1-PLAN.md)：先固定线上Hermes部署版本与实际客户runtime/连接；隔离环境跑A/B资料与附件负向测试，再接独立Resend测试邮箱验证草稿、实际收件、附件及失败恢复。没有这两层证据，不将fake、SMTP旧路径或本地HTTP结果当作联调完成。
