# D1 函数入口：生产观测、兼容报告与受控恢复

2026-10-22。代码使用原 `feat/seo-foundation`。本次补齐 C2 的现场观测与兼容证据生产链，并接入 D1 人工函数入口；**真实函数恢复保持关闭**。本地发布回归 375 项、lint 870 个文件及 SDK 合同检查通过。精确提交 CI 和 Actions 只读现场结果保存在 `output/seo-module-04-function-entry-2026-10-22/`，不能用本地通过代替现场验收。

## D1 和 C2 的区别

D1 是操作者使用的发布/恢复入口：选择版本和范围、校验计划、取得共享锁、创建运行记录、调用适配器、提交验收后的激活。C1 负责静态托管，C2 负责 Cloud Functions 代码。本次接的是 D1 的函数恢复部分，普通 Deploy Test 仍沿用原实现；整站发布接线和 D2 自动恢复不在本次启用范围。

入口继续使用已经注册的 `.github/workflows/seo-static-canary.yml`，没有新建 workflow、分支或 worktree。新增 `functions` job，与原 canary/maintenance 按模式互斥，共用 `cloudbase-deploy-test` 且不取消正在运行的交付。原八个 dispatch 输入复用，不把正常发布改成必须先跑 SEO 恢复。

## 模块和操作

| 模块 | 本次职责 |
| --- | --- |
| `function-observation.mjs`、`function-health.mjs` | 实际 SDK 包 hash、运行代码 SHA、runtime/handler/role/layers、配置版本、数据/客户端版本读回 |
| `function-test-runner.mjs`、`function-report.mjs` | 运行当前 checkout 中已审查、固定源码 hash 的兼容测试；消费真实结果生成报告 |
| `function-report-artifact.mjs`、`function-github-source.mjs` | 独立数据归档、GitHub 来源/attempt/digest/有效期及数据文件解包校验 |
| `function-orchestrator.mjs` | 只读计划、五分钟 review token、持锁重算、调用 C2、最后提交 B1 |
| `run-function-recovery.mjs` | 从固定人工 workflow 取得身份和凭证，组装上述生产适配器 |

| workflow mode | 行为与输入 |
| --- | --- |
| `function-observe` | 只读三个函数、health、控制权限、契约文档和 site 激活；保存实际版本及未就绪原因 |
| `function-certify` | `variant` 选一个函数、`restore_run_id` 选已验收 A；运行固定兼容套件，归档机器结果 |
| `function-report` | `artifact_id` 为前一步成功测试归档；重读现场、生成并归档兼容报告，输出计划/token |
| `function-plan` | `artifact_id` 为已有兼容报告归档；只读重算计划 |
| `function-execute` | 原报告 ID、明确 A run、当前激活、原因和 token；仅在仓库策略开放后执行 |

函数模式中 `variant` 是 `public-api`、`admin` 或 `alibaba-catalog-sync`；静态模式仍使用 A/B。第一期人工 workflow 每次只选一个函数，底层协调器支持显式函数集合。`expected_activation_id` 和 `reason` 继续使用原输入，`plan_token` 仅 execute 需要。输入通过环境变量传给固定命令，不拼接 shell。

## 生产观测如何成立

每个函数先通过 SDK 下载包，再读 health，最后重新读取 SDK 包和配置。前后 hash、配置或生命周期不同就拒绝这次观测。health 使用现有接口，不提交询盘、改商品或登录业务账号。新鲜观测最多五分钟；HTTP 继续复用带超时和正文上限的公共请求层。

配置内容在进程内比较，计划和归档只存 HMAC 版本。Actions 从现有云 SecretKey 按目标派生专用 HMAC key，不新增客户密钥配置；相同部署凭证下跨 job 稳定，凭证轮换后旧计划自然失效。环境变量不进入报告，签名下载 URL 不进入日志。

数据/客户端观测读取现有 ADMINONLY 集合中的一个独立元数据文档：`siteReleaseTargets/compatibility-<targetId>`。普通 Node SDK `doc().get()` 的 `data` 是数组；事务读是单对象，代码和测试分别遵守真实合同。**入口没有创建集合、补写文档或把缺失状态当兼容的能力。**

这份文档由 B2 的业务写入合同接入，最少包含：

- `schemaVersion=1`、`purpose=function-recovery-contract-state`、精确 target 和 revision。
- `data`：格式契约 revision、全部在用 formats、约束身份 `constraintsSha256`。这里是数据格式契约的版本，不冒充商品内容 generation。
- `writers`：`coverage=all`、经过审查的 inventory hash、函数名及已纳入契约的 `codeShas`。保留 A/B 等已知版本；恢复 A 后仍能观察，不能只登记 B 然后让恢复后的 A 被误判为陌生写入方。
- `clients`：`coverage=all-exposed`、审查后的 inventory hash、revision 和所有已暴露的客户端 API contracts。不能只看当前静态页面，遗漏仍开着的新客户端。

写入方必须在引入新数据格式/约束或客户端契约时同步维护状态，不能手填 `coverage=all` 当作完成接入。当前 policy 的两个 inventory hash 为 null，兼容套件列表为空，真实执行为 false；这些是尚未取得证据的明确状态。本次不替 pricing/product-sync 修改写入事务，也不创建一条声称覆盖它们的生产记录。

## 兼容报告不靠 compatible=true

`function-certify` 仅运行仓库 policy 固定的 `scripts/compatibility/*.test.mjs`，同时核对脚本 SHA、四类套件和必须实际执行的具名用例。套件在没有云凭证的子进程中运行，取得只读原 ZIP 副本和绑定后的契约上下文。空测试、skip、todo、失败、超时、源码 hash 不符或缺少具名用例都不能生成通过证据。

四类是旧读取器、旧写入器保留未知字段、已暴露客户端兼容、保留配置兼容。suite 声明的格式/API 覆盖也受仓库审查约束。现有全仓测试不会被自动贴成这些业务兼容测试；对应历史包尚无已注册套件时，返回明确的未就绪原因。测试中的 synthetic 套件只验证执行链，不能拿来启用生产恢复。

成功测试归档必须来自固定仓库/ref/workflow 的成功 attempt，执行器 SHA 也必须有成功 offline CI。生成器再绑定现场上下文。报告归档只有 `payload-manifest.json` 和 `compatibility.json`，不夹带占位首页或假网站快照；C2 继续支持真实站点发布包内的兼容报告。GitHub ZIP digest、原始 JSON 字节 hash 和原函数 ZIP hash 各自验证，不互相替代。下载存储跳转不携带 GitHub token。

## D1 执行和失败边界

plan 不获取 B1 租约、不改控制记录。execute 先核对原 token，再取得环境租约，重新读取 active、scope version、已验收 A、报告和现场观测。token 绑定执行器 SHA、原因、函数名单、归档、当前激活及兼容上下文；五分钟过期。函数包、配置或数据/客户端版本变化后，不能拿旧计划继续。

随后 D1 创建显式 function-only restore run，C2 先持久化 intent、提交原 ZIP、等待 Active/Available、核对包与 health，并重新确认兼容上下文。D1 最后创建新的 activation。当前 static 组件与对应 seal 保留，不恢复数据库、不发送搜索通知。超时、失去租约、未知提交或失败验收保留待核对状态；不直接重试、不启动第二次恢复。D2 的自动恢复仍未开启。

## 写入范围、A→B→A 和停止条件

本次真实验收只运行 `function-observe`：云端只读；GitHub 会创建 Actions run 和证据 artifact。没有函数/静态配置/业务数据/B1 记录写入。

未来开放函数演练前先给出精确 A/B 包、函数和 health 标记，完成对应套件与 B2 状态接入，建立可信 site 基线。每次只演练一个函数：A 的原包及现场验收归档 → 发布只有无业务影响版本标记变化的 B → 人工指定 accepted A、生成计划 → C2 恢复 A → SDK 原包 hash、health SHA、新激活与保留数据验收。保留历史和额外字段，不做数据库 down 或全库覆盖。当前入口不提供初始 site adoption，也不能用已有静态 canary 基线冒充函数基线。

任一条件出现即停止：来源/目标/CI 不符，A 或报告过期/损坏，没有函数级 seal，缺数据/客户端完整覆盖或对应测试，当前激活/配置/包漂移，未知 intent、dirty/stalled 状态，租约丢失，SDK 回执/终态或 health 不符。停止后先读回未决调用，不因为 job 已结束或 TTL 到期就再次写入。实际演练前还须单独说明 B 发布失败时的恢复边界；本次没有暗中做这项线上演练。

## 审阅和验证

复用了原 GitHub 只读 transport，静态 canary 的来源限制保持原值；新增 profile 只接受函数 payload 或兼容测试结果。原 canary、maintenance 的回归继续通过。新的流程测试验证所有模式恰好选择一个 job、凭证只进入两个固定入口步骤、归档先于执行、关闭策略在 SDK 调用前拒绝 execute。

53 项新增测试覆盖观测、报告、测试执行、独立归档、实际 Manager SDK + B1 的 D1 恢复及 workflow。完整发布回归 375/375。测试还发现并修正了提交结果覆盖 `accepted` 状态的字段顺序问题。CloudBase 合同核对使用已安装 Manager 5.9.1、数据库 1.4.3 源码与官方 MCP 文档；Context7 不可用，没有新增 SDK shim 或依赖。

文字审阅覆盖本页、模块 03/04、执行索引和 CURRENT_EXECUTION。将“生产兼容通过”限定为“对应生产上下文的固定业务测试实际通过”；将“D1 全部完成”限定为“人工函数恢复入口接线完成，正常整站发布和自动恢复尚未切换”。核对事实为 375 项回归、870 文件 lint、原有发布文件保护及关闭策略。

## Actions 入口首次实测后的修正

提交 `a1e7a272` 的整仓 CI 856/856 通过，但只读入口 39714879004 在 SDK 加载时失败。原因是入口从 `packages/media-storage` 解析 `@cloudbase/node-sdk`，而 pnpm 隔离安装下该依赖实际由 `packages/db` 直接持有。本地实际构造 SDK 客户端复现了 MODULE_NOT_FOUND；修复后同一客户端构造和 env/transaction 合同通过。静态 canary 入口也改为共用同一个 SDK 构造方法，普通 Deploy Test 不变。

补充两项测试：真实 pnpm 依赖路径的客户端构造，以及不丢失 stage/code、也不泄露原始消息的失败诊断。首次任务只做过 CI/目标/控制面读取，没有函数、静态文件或业务数据写入。修复后的精确提交仍需通过 CI，再重跑只读现场入口；实际结果随远端证据归档。
