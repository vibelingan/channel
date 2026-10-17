# P2f10a：保存当前非就绪诊断

checkpoint-preparation 只接受当前 opaque lease、previewReady 和受限 issue。服务端绑定 job 的 product/input/generation/time，结合实际持久化媒体 invalid/retry 数量生成 v2 blocked/preparing 报告。调用方不能指定 ready、另一个商品、旧输入或时间，不能保存任意错误原文。

source-backed 事务最多七次点读写：job/product/source/observation/link 后，同时更新商品的报告字段和同一 job 的 mutationRevision。保留分类、发布、归档、用户更新时间、已批准版本、图片和引用计数。异步读后和每次写后都查租约；到期抛错由外层事务回滚。输入改变只标旧 job stale，不覆盖当前商品。同一服务时间、相同报告的重放可零写入确认。

错误诊断优先于警告；已有 50 条警告时，实际媒体错误仍须出现。50 条错误时保留错误优先级，不为 retry 警告挤掉错误；相同媒体问题不重复。坏预览没有任何错误说明时拒绝不一致命令。媒体完整 cursor 也不能绕过完整摘要和最终提交变成 ready。

初始两项红测明确在动作尚不存在时失败。首轮 244 项组合通过；另补满额错误和去重两个分支。原生事务八种写 ACK 异常、两次写后到期均回滚；真实像素阶段后的快照可在文件重开后读取，磁盘失败保持原商品和 job。初次类型检查发现 findLastIndex 超出项目 ES2022 lib，改为最多 50 次的倒序循环；没有扩宽 tsconfig 或运行时约定。

八个源码反例分别移除媒体错误、retry remedy、满额诊断替换、当前输入、租约、写后到期、job fence 和 unchanged 确认；在选定 48 项中均被检出，41–47 个正控通过，原文件字节恢复。完整扩大、最终类型/Node20/SDK与产物证据在实施记录追加。

本单元提供仓库合约，默认 worker 尚未调用它。未改变 release/dispatch 的终态规则，未暗含取消、列表或 UI 状态模型；下一单元接线并测试小流程。现有公开版本保留，非就绪报告没有发布权。完整用户过期恢复、准入/UI、历史修复和现场验收仍待完成，fullDeliveryReady=false。

文案核对 checkpoint/jobs、完整候选诊断、共享 report schema、native/JSON 测试；把“媒体已检查即可就绪”改为“本动作始终非就绪，最终校验另验”。七次预算、诊断数量上限、两行回滚和原用户字段均对照程序断言；未称云端 MVCC/COS 或实际发布验收通过。
