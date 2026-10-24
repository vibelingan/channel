# P2a 事务合约核对

2026-10-13；实施中，真实 CloudBase 并发验收尚待管理授权。

源码使用已安装 @cloudbase/node-sdk 3.17.2 → @cloudbase/database 1.4.3 的 transaction/index.js；wx-server-sdk 4.0.2 保持原职责。没有新增 SDK 方法或 ambient declaration。Context7 本会话未提供；已用 CloudBase 官方知识库读取 /database/transaction，并对照本地实际 runtime。

官方文档确认事务为快照隔离、读取不获取写锁、单事务最多 100 个操作/30 秒、仅 doc，不支持 where。文档示例 callback 返回外包装与已安装运行时不同，继续以已执行的 runtime probe 为准。新来源事务只按已知 doc ID 读取 lease/observation/link/product；所有读取在写入前，最坏 6 个终端操作。最后批准没有增加新记录读写，generation 加入已有 product 指纹。

事务读返回 data；bare database 的 coded answer 可能作为对象返回，沿既有 sdkAnswer 重新抛出。已有文档 update/set 的确认是 updated=1，新 set 可为 upserted[{_id}]；静默零回执使整个来源/产品事务回滚，测试分别注入 source/product 写前失败和无回执。完全相同的文档不写，避免把合法 no-op 误判写失败。

来源写入消费者已搜索：ingest 与 raw replay 调用 fenced upsert；runner tombstone 调用 fenced update；通用 provider-neutral observation 写入调用专用 upsert。当前明确主来源只有 Alibaba；其他未绑定的来源不会改无关产品。新绑定与普通 row/media/classification 写入属于后续 P2，尚未由这些探针证明。

SDK gate 首轮发现 3 个失败：原断言要求 adapter object method 内直接出现 runTransaction/guard，提取生产 helper 后已不在该方法体。改为 AST 跟踪 object method → 指定 helper → runTransaction callback 中的实际 read/guard/write 调用，并要求来源失效与产品写入同处回调。没有移除校验；新断言限制函数范围，避免在整个模块找到另一 helper 的 guard 而假通过。

执行结果与 mutation 证据见 IMPLEMENTATION_LOG。未授权读取云数据库或执行云端 race 时，不以本地 fake/JSON 事务代替供应商验收。
