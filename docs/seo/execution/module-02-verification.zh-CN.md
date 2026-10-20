# 模块 02 / B1 验证记录

本轮只交付发布协调器 B1。B2 的商品公开内容事务、云端适配器 C 和发布入口 D 尚未接入，因此不会启动线上恢复、创建控制集合或阻塞后台商品编辑。

开发基线为 `feat/seo-foundation@15bd65bbecd85e7f7a42a002baacf599a31a72b7`。2026-10-21 重新 fetch 后，`origin/main` 仍为 `37bcea5b38284210159e95f8d10f3a9b5cf2ee44`。本轮没有合并、切换或修改其他 worktree；没有改 pricing、应用界面、业务数据库、package.json 或 lockfile。

## 实现与检查范围

| 文件 | 本轮检查的行为 |
| --- | --- |
| `scripts/release/state.mjs` | 目标租约、固定计划、步骤日志、接手证明、原子激活、失败恢复关联 |
| `scripts/release/ledger.mjs` | 目标与 scope 身份、计数器、组件及 artifact 引用校验 |
| `scripts/release/store-cloudbase.mjs` | 指定环境、先读后写、固定文档 ID、SDK 错误处理和事务边界 |
| `scripts/release-coordinator.test.mjs`、`release-state-fixtures.mjs` | 独立协调器竞争、进程重建、过期租约、幂等确认、迟到应答、部分组件交付及恢复失败链 |
| `scripts/release-store.test.mjs`、`release-cloudbase-fixture.mjs` | 实际安装 SDK 的事务/get/set/冲突重试，应答缺失或错误时拒绝成功 |
| `scripts/release-integration.test.mjs` | 模块一恢复内核与 B1 日志联测，临时文件发布失败后恢复 A，并更新 baseline |
| `.github/workflows/seo-module-1.yml`、`scripts/release-module-ci.test.mjs` | 独立 offline CI，只有 contents:read，无云凭证、部署、环境绑定或自动工作流调用 |
| 本模块设计页与执行索引 | B1/B2 状态、交付顺序及真实云端尚未验证的边界 |

审查采用现有 `ENGINEERING_CRAFT.md` 的计数器、部署和测试规则。关键核对包括：同目标 site/canary 共用 lease；过期不能直接抢锁；未确定操作不能获得第二次写许可；写前失败不要求恢复；恢复自身失败保留原发布损坏；静态单独交付保留函数原有 seal；旧提交重放不能覆盖新激活。事务回调没有云调用或 GitHub 操作。

本轮自行复审，未委派其他 agent。没有把自审称为独立代码审查。

## 本地验证

恢复中断前的源码后，重新运行以下检查，原临时目录中的历史日志不作为本轮通过证据。

| 命令 | 结果 |
| --- | --- |
| `node --test --experimental-test-coverage scripts/release-coordinator.test.mjs scripts/release-store.test.mjs scripts/release-integration.test.mjs` | 56 通过，0 失败 |
| `pnpm lint` | 815 文件通过 |
| `pnpm verify:cloudbase-sdk` | 通过 |
| `pnpm test` | 正常退出 0；合计 2972 测试通过，其中根目录脚本 618 个，0 失败 |

定向测试中，`state.mjs` 行覆盖率 98.76%，`ledger.mjs` 与 `store-cloudbase.mjs` 行覆盖率均为 100%。覆盖率只描述该组本地用例，不证明供应商的并发、持久性或云端恢复能力。

当前 SDK 为 `@cloudbase/node-sdk@3.17.2`、`@cloudbase/database@1.4.3`、`wx-server-sdk@4.0.2`。Context7 与 CloudBase MCP 在本次续接时不可用；重新核对了[官方事务文档](https://docs.cloudbase.net/en/database/transaction)和安装包的 `transaction/index.js`、`document.js`。实际 SDK 的 `runTransaction` 返回回调结果，事务 get 返回对象或 null，set 接受原始对象。网络 fixture 只替换 SDK transport，事务代码仍执行安装包实现。

## CI 和真实验收边界

沿用模块一的独立 workflow 文件，增加 SDK 合同检查，并将回归命令扩展为现有 `pnpm test`。安装仍使用 frozen lockfile、忽略生命周期脚本。原 `ci.yml`、`deploy-test.yml`、`e2e.yml`、`deploy-ai-cloudrun.yml` 必须保持与基线逐字节相同。

推送后按提交 SHA 检查实际触发的工作流及最终结果，链接与日志保存在本次交付记录。没有因此合并 test/main、触发部署或执行生产试写。默认 `pnpm test` 不包含现有脚本排除的真实 PostgreSQL 套件，也不是浏览器 E2E。

启用前仍需 C/D 提供真实 job 终态、云调用静止和读回证据；建立 server-only 集合规则后，完成真实 CloudBase 并发 fixture。B1 只检查证据字段及绑定关系，不认证调用方自己填写的 evidenceRef。本轮没有证明线上自动恢复或恢复耗时。

## 文档措辞核对

已检查本页、`02-coordinator.zh-CN.md` 和 `README.zh-CN.md`。状态措辞明确为“本地 SDK 合同验证”，避免将其写成“持久层已验证”。事实依据是实际安装 SDK 加网络 fixture 的通过结果，真实云端并发和持久性仍待验收；保留组件沿用原 seal，也没有被写成重新验收过的组件。

下一项是模块 03 / C1：静态托管与配置适配器的提交、终态和真实读回。B2 在后续主线整合窗口接入。
