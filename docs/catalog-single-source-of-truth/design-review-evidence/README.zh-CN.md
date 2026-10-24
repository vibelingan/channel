# 本轮离线设计反例

这些文件只保留设计复核证据，不是已集成的修复或通过测试。

`counterexamples.mts.txt` 是执行过的只读源码探针，调用真实 admin API client
函数并模拟 fetch；没有调用线上 API。`counterexamples.tap.txt` 是原始输出：
3 个检查，2 个失败揭示并发下架被重新发布、manual 缺版本后丢 guard；1 个
通过，说明 wrong-product 读回已被 getRecord 拦住。

`backend-save-plan.json` 记录独立核对：真实保存计划接受无版本的重新发布，
加入旧版本条件则拒绝。首次运行曾写错相对 import 路径，改正路径后才得到
该结果；模块找不到的输出没有用作业务证据。

没有修改业务源码、没有提交/推送、没有 CI/部署，没有真实商品测试。
三件时钟的真实错误字段仍未知。

SDK 核对追到了实际 import：node-sdk database() → @cloudbase/database
`dist/commonjs/index.js` → `./transaction/index`。该运行路径保留 callback
返回值、提交、rollback，并仅对 DATABASE_TRANSACTION_CONFLICT 重试。
同包另有旧的 `transaction.js` 文件，但 index.js 没有引用它，未据它报 SDK bug。
已对照 verify-cloudbase-sdk-contract.mjs 中同一真实路径及 types/db.d.ts
的 collection 契约；本轮未运行云端 transaction 或更改 SDK。
