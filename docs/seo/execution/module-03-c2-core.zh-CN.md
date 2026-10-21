# C2：函数恢复的兼容检查与归档计划

2026-10-21。状态：**核心代码和本地测试完成，云端函数适配及现场恢复未接入。** 沿用 `feat/seo-foundation`；本轮不修改正常部署 workflow、函数代码、业务数据或 pricing。

## 为什么先做这部分

F1 的 404 已修复，静态响应已改为 no-cache。只读核对发现 main `404d1a25`、pricing `39705e23` 的旧部署脚本都设置 `ErrorDocument=index.html`，下一次旧流程发布会覆盖专用错误页设置。相同的 `cloudbase-deploy-test` 锁只能串行执行，不能合并两个分支的交付结果。本轮因此不启动静态 A→B→A，canary policy 重新关闭；旧流程接入需在合并窗口统一处理。

无需占用部署目标的下一块是 C2 的兼容检查。新增字段本身不一定阻止旧代码运行；危险来自旧写入器整条替换文档、格式变化、新约束、旧 API 无法服务已打开的新客户端，或恢复配置时覆盖密钥与人工配置。当前实现要求这些关系有对应测试报告，并与当前版本相符。

## 模块接口

| 文件 | 本次交付 |
| --- | --- |
| `scripts/release/function-compatibility.mjs` | `functionRecoveryContext` 绑定当前上下文；`evaluateCompatibility` 返回 allowed / manual-required 及原因 |
| `scripts/release/function-recovery.mjs` | `planFunctionRecovery` 校验归档与函数级验收记录；`assertFunctionRecoveryCurrent` 在后续执行前重新核对；`readFunctionRecoveryPackage` 再次校验字节 |
| `scripts/release/function-config.mjs` | `mergeFunctionEnvironment` 在可信进程内保留现有环境变量，只允许明确的受管修改或移除 |

这些接口不调用 SDK，不注册路由，不启动部署。返回计划固定 `execution=not-connected`，配置写入、函数删除和数据库写入均为空。C2 整个 MIU 仍在进行，不能把核心测试通过写成线上函数恢复可用。

## 恢复计划怎样得到

1. 由后续可信 GitHub 适配器取得旧包和兼容报告的来源元数据，再复用 A1 `verifyReleaseArtifact` 校验文件、hash、目标、分支、过期时间和验收 seal。校验器不自行认证调用者传入的元数据。
2. 从 B1 读取明确的已验收 run。除整包 seal 外，要求 composition 存在 `function:<name>`，且该组件的代码 SHA、包 hash、归档引用和函数 seal 均与旧包一致。静态页面验收成功不能替代函数验收。
3. 从兼容报告归档读取 `function-recovery-compatibility` 报告。它可以来自当前候选发布的 CI，用于证明旧 A 与当前 B 的关系；不能要求旧 A 在生成时预知以后 B 的数据格式。
4. 报告绑定目标、函数名、旧包身份、当前运行代码、runtime/handler/role/layers、数据 revision/格式/约束、已暴露客户端 API 合同，以及当前配置 revision/密钥引用版本。现场观测必须在五分钟内，且不在未来。任何一项变化都会使旧报告失效。
5. 读取、保留未知字段的写入、客户端兼容、当前配置四类测试均需通过并有 testRef。还要求格式支持集合覆盖当前所有格式，API 支持覆盖已暴露的客户端，必需配置引用仍在。当前函数必须 Active 且计费 Available。
6. 本次计划只支持恢复代码、保留当前配置。runtime、handler、role 或 layer 不一致时拒绝此范围；不猜配置也能兼容。多个函数中任一不通过，整个请求不返回部分计划。
7. 计划有效期最多五分钟，不超过两个归档的有效期。未来执行器必须在共享锁和 B1 租约内重新读取上下文，再校验包字节；现在没有可绕过这些步骤的线上执行入口。

报告由归档 hash 保护，**不会自动证明报告中的测试真的覆盖了业务语义**。后续 CI 生产者必须实际运行旧读取器/写入器、历史数据与新客户端测试，再产出报告。当前仓库没有生产兼容报告或观测适配器，所有新增测试 fixture 明确为 synthetic。无法提供这些证据时，真实恢复保持拒绝。

## 配置保护

`mergeFunctionEnvironment` 只接受可信读取方明确提供的完整变量表；发现 `***`、带星号的局部遮盖或 redacted 占位值就拒绝，不退化为 manifest-only 更新。非受管变量保留，省略的受管变量也保留；需要移除时必须在 `removeManagedKeys` 明确列出，且不得同时设置和移除同一键。

合并结果含真实值，仅可在可信部署进程内使用，不进入计划、日志或 artifact。兼容上下文只存配置 revision 和引用版本，不含环境变量值。没有数据库 down、删列、删表或全库回放。

## 验证

本次新增 70 项核心测试，覆盖允许路径、旧格式缺失、未知字段丢失、新约束、新客户端、配置或密钥引用变化、Updating + Available、归档/函数 seal 不符、过期、包篡改、symlink、部分计划和变量丢失。最初两个接口测试在未实现时失败；新增边界测试发现并修正了无效函数名和路径未验证的问题。外部环境测试的 fixture 共用了 target 引用，也已改为独立对象，避免误测。

`node --test scripts/release*.test.mjs scripts/hosting-cache-plan.test.mjs scripts/cloudbase-function-state.test.mjs`：286/286 通过；全仓 lint：847 个文件通过；SDK 合同检查通过。精确提交的远端整仓 CI 另见提交后记录。

## 尚未接入的部分

后续 C2 需核对并实现 CloudBase 函数实际代码上传、终态等待、代码身份读回和 B1 步骤日志，复用现有冷启动 smoke；不能重编译旧提交后当作原归档。配置读取若只有脱敏值，对应写入资格保持拒绝。还需实际兼容报告生成和当前数据/客户端/配置观测来源，最后才能连接 D1 的函数发布及一次受控 A→B→A。

静态 F1 待旧发布器的错误文档合同统一后继续。Blog、Tiptap JSON 渲染和 Hermes 草稿导入仍是后续独立模块，本轮未实现。

本次文字审阅覆盖本页、模块 03、执行索引、CURRENT_EXECUTION、404 记录及模块六记录。把“C2 已完成”限定为“兼容与归档计划核心完成”；核对的事实包括实际导出接口、70/286 项测试结果、policy 关闭状态、旧脚本的 index.html 设置和公网 404/hash。没有把可信输入假设或 synthetic fixture 当成现场兼容证据。
