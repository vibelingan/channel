# P2f9c3：当前输入的原子就绪提交

商品详情通过校验、采用图片逐张核对后，技术 worker 才能提交就绪记录。本单元实现仓库合约；默认 worker 的接入留给下一单元，不因新增 ready 数据结构改变线上列表或发布行为。

v2 ready 报告必须包含 jobId、receiptId、完整媒体计划与有序图片集合摘要、数量及当前媒体/像素 policy。shared 定义 policy，DB 沿用同一常量；浏览器模块没有 Node crypto 依赖。旧 v1 ready 不构成当前就绪依据。原 preparation-report 内部快照命令只允许 preparing/blocked；其 schema 与直接仓库函数分别拒绝 ready，HTTP 审批仍拒绝此内部命令。

finish-preparation 只接受当前 opaque lease，核对完整媒体 cursor、逐张摘要、全候选输入/版本/图片数量和根摘要。事务再读当前 product/source/observation/link；同时写 v2 report 与 completed job，清除运行租约，保留发布、归档、分类、用户更新时间。source-backed 共 7 次点读写，事务内无图片循环、字节读取或 provider 调用。

完成回执绑定原 owner/version、命令摘要与已保存报告摘要。提交成功但响应丢失时，只有原 WeakMap grant 能只读确认同一结果；序列化对象、不同命令、旧输入或被替换的报告均拒绝。服务重启后的用户恢复应读取完成状态，不能重建技术 grant。异步读后再校验租约；两个写入之后均检查到期，到期抛错由适配层回滚整个事务。

实际本地 3 张图片经过默认保护/像素检查、逐张 attestation 与 fresh candidate 后完成，重开文件可读 ready；缺主分类依然缺主分类，未发布。105 张真实独立配置图完成原 27 步检查、105 次核对及最终提交。完成阶段禁用 GET/PUT 仍成功。实际文件提交后丢 ACK，可原命令恢复而不重复写文件。

首次集成 236/239，通过项保留；3 个失败来自新夹具假设（未设置 published 不能断言为 false；观察与链接原本不存在），随后按实际记录修正并全部通过。首次类型检查发现测试宽类型及 Zod predicate 推导收窄，修正后重跑；不作为产品故障。首轮 Biome 拒绝 delete，不采用改变缺字段语义的 undefined 修复，改用 Reflect.deleteProperty。

八个实际源码反例分别移除图片根、完整摘要、pixel policy、fresh input、写后到期、ACK 恢复、raw ready 拒绝、v2 旧报告拒绝；每项检出 1–47 个失败，172–218 个正控通过，三个文件原始字节均恢复。日志及恢复 SHA 在 output/pricing-clock-repair-2026-10-13/p2d9/final-ready-*。

扩大回归、消费方类型、Node20、SDK 与精确构建结果随后在实施记录和提交 review sidecar 追加。这里没有云端事务/COS权限验证、test 发布或现场 20 件验收。fullDeliveryReady=false。

文案复核：实际核对 preparation.ts、store/jobs/finish、media-seal/protected-pixels、Cloudwrapper 与 JSON/真实图片测试；将“写成 ready 就可发布”改为“就绪记录；发布仍需操作意图、分类、审批及当前输入校验”。测试数字、7 次事务预算、未分类/未发布状态均对照日志与断言。
