# C2：函数代码适配、读回与发布日志

2026-10-22。状态：**SDK 适配及本地协调器集成完成；仅做过线上只读核对，未开放真实函数恢复。** 使用原分支 `feat/seo-foundation`，承接 [C2 兼容与归档核心](module-03-c2-core.zh-CN.md)。

## C2 是做什么的

C1 处理静态文件，C2 处理 Cloud Functions 的代码包。例如发布 B 后接口发生故障，C2 在证明旧 A 仍能处理当前数据库和已打开的客户端后，上传原来验收过的 A 包，再确认实际运行的是 A。它不修改商品业务接口，也不把后端换成另一套架构。

数据库不会跟着回放。新增字段默认保留；旧写入器是否保留新字段、旧 API 是否兼容新客户端，必须有当前版本对应的测试证据。缺证据就拒绝恢复，而不是假定兼容。

## 本轮模块和接口

| 文件 | 职责 |
| --- | --- |
| `scripts/release/function-archive.mjs`、`check-function-zip.py` | 校验原 ZIP 的边界、文件和依赖；在无云凭证的临时目录做加载检查，不重新打包原件 |
| `scripts/release/function-provider.mjs` | 固定环境和函数名单；通过 Manager SDK 读取配置、下载包计算 hash、提交原 ZIP |
| `scripts/release/function-health.mjs` | 复用三条现有 health 路由，核对服务名和运行代码 SHA |
| `scripts/release/function-adapter.mjs` | 在 B1 租约和运行计划内记录 intent、提交、等待、读回、确认；最后确认函数范围 |

`functionCoordinatorPlan(plan)` 把 C2 计划转换为 B1 使用的计划身份。D1 负责取得锁、创建 restore run 和最后 `commitRun`；C2 不自行移动 active，也不自行启动自动恢复。接口是可测试的库，本轮没有新增线上执行命令或修改 workflow。

## 一次函数恢复的顺序

1. D1 选择已验收 A 的归档和函数级 seal，取得共享锁、B1 租约，创建明确包含这些函数的 restore run。
2. C2 重新核对目标、run 计划、当前数据/客户端/配置版本和有效期，读取原 ZIP 并做加载检查。
3. SDK 读取现场配置和当前 ZIP。函数名、环境、runtime、handler、role、layers 或当前包身份不符合计划时，不更新。
4. **先持久化 B1 intent，再调用代码更新。** 上传归档原字节，`InstallDependency=FALSE`，不在恢复现场重新安装依赖。
5. 保存提交回执；轮询到 `Active + Available`。下载实际包重新计算 SHA-256，确认配置未漂移，再通过 health 路由确认运行代码 SHA。
6. 再读数据、客户端及配置上下文，确认恢复过程没有改变兼容前提，才确认该步骤。
7. 全部请求的函数重新验收后确认 scope。D1 最后提交新的 activation，历史记录保留。

当前观察还绑定现场包 hash，layer 的顺序也参与比较。不能只靠相同 Git SHA 或相同 layer 集合判断一致。

## 支持范围与失败处理

本轮只支持现有三种打包后的 Event 函数：`public-api`、`admin`、`alibaba-catalog-sync`。ZIP 仅含 `index.js` 和 `package.json`，不含运行时待安装依赖，最多 1.5 MiB；这个限制来自当前安装的 Manager SDK 内联上传路径。其他布局、容器、CBF、VPC、触发器、加密代码包或不能证明完整的配置均拒绝，不自动切换另一种上传方式。

SDK 只暴露读取和代码更新；没有配置写入、创建/删除函数、触发器或路由接口。恢复保留当前业务配置，`InstallDependency=FALSE` 是计划明确绑定的打包策略。配置比较使用进程内随机密钥的 HMAC，输出不包含环境变量或可离线猜测的明文配置 hash。错误信息不透出 SDK 原始响应、签名 URL 或密钥。

超时、失去租约、取消、回执丢失、错误包、错误 health 身份或配置漂移均不确认成功。有写入 intent 的失败保留 unknown，禁止直接再次上传。**取消等待不能撤销已发出的 SDK 请求。** 测试覆盖了调用方已停止后 SDK 仍迟到成功的情况：日志仍待核对，不确认、不提交、不重试。跨进程恢复还需证明旧 runner 与云调用终止，并重新取得可信配置证据；本轮不提供无条件续跑。

## 合同核对和实际验证

按项目 SDK 合同规则，核对了安装的 `@cloudbase/manager-node@5.9.1` 源码与类型、CloudBase MCP 官方文档和 SCF GetFunction 文档。Context7 当前不可用。没有添加 SDK shim 或依赖。

SDK 路径是 `getFunctionDetail`、`getFunctionDownloadUrl`、`updateFunctionCode({ func, base64Code })`。测试运行真实 Manager SDK，仅替换网络传输；它验证实际请求参数和原 ZIP 字节，而不是只验证自定义 mock 的方法名。

| 验证 | 结果 |
| --- | --- |
| C2 专项 | 106/106，通过兼容、归档、SDK、health 和协调器测试 |
| 发布模块回归 | 322/322 通过 |
| 全仓 lint | 855 个文件通过 |
| `pnpm verify:cloudbase-sdk` | 通过 |
| `pnpm package:functions` 与三包新校验器加载 | 通过，三个包均小于上传上限 |
| 线上只读 `public-api` | 环境/namespace 一致，Event、Nodejs20.19、index.main、Active、Available；成功下载 466837 bytes 并计算包 hash |
| 线上更新/恢复 | **未执行**，本轮函数更新数和业务数据库写入数均为 0 |

线上只读包 hash：`fa0dcd505002cbfff17524d4f065c0972f37bed186a3b7b9bd5d03145ead734a`。证据在 `output/seo-module-03-c2-adapter-2026-10-22/`；不保存签名下载地址和环境变量。它证明当前 SDK 读路径可用，不能替代真实上传验收。精确提交的远端 CI 结果另存该目录。

## 下一步的边界

2026-10-22 后续交付已补上生产观测、固定测试/报告生产链和 D1 人工函数入口，见[本轮记录](module-04-function-entry.zh-CN.md)。目前生产资格仍缺 B2 全写入方/已暴露客户端版本状态、相应历史函数的已审查套件及可信 site 函数基线；synthetic fixture 不能作为这些证据。实际函数恢复和 A→B→A 仍未开放，静态 F1 另记。

本轮未改正常部署脚本、现有 workflow、业务函数、pricing、UI 或 schema。Blog/Tiptap/Hermes 草稿接口仍按后续模块实施。

文字审阅覆盖本页、C2 核心页、模块 03、执行索引、CURRENT_EXECUTION 与 404 记录。将“适配代码完成”等同“线上恢复可用”的表述拆开，并将“返回 404html”改为分别写响应状态和正文。事实核对包括 106/322 项测试、SDK 参数、三包加载、只读包身份及公网 200/404 响应。
