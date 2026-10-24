# P4c9e1：浏览器保留 live 原任务

本单元扩展浏览器协议和恢复记录，还未切换编辑表单入口，未部署、未改真实商品，fullDeliveryReady=false。

首次发布和 refresh-live 共用客户端 runner、四路 batch、公开读回和同账号恢复，但有不同的原始意图。新 live 指针在本地 scope 中保存 intent=refresh-live；旧指针省略该字段，仍按 publish 读取。读回必须匹配原意图、商品、任务及已知输入摘要。继续/查询/取消请求只发送服务器支持的字段，不把本地 intent 字段混进 wire DTO；start/stop 显式带原意图。空输入恢复可重建相同意图的 start，私有表单输入继续不落入 localStorage。

恢复记录不能从 publish 改成 live，或反向更换。draft/creation 两个独立 journal 拒绝 live 指针。原 raw-save 满槽游标在只读 GET 后仍保留；新的分页/回复取代旧游标。runner 把 saveReferences 纳入进度判断，分段保存推进时不会被当成无进展。所有操作继续受当前账号、角色、token、环境、同商品互斥和原任务约束。

证据位于 output/pricing-clock-repair-2026-10-13/p3e1/live-client-protocol-*。三条有效新测试在旧客户端均失败；协议和草稿回归 282/282，0 跳过；实际后端集成 44/44，0 跳过。新增三条实际 batch 场景使用真实 Admin、JSON native 保存/审批、PNG worker 和公开 HTTP，覆盖 live 完成、公开读回暂不可用后仅检查、start 未到达时按原 live 意图停止；旧发布/批量/原 start 场景一并通过。Node20 的协议/草稿/实际编辑后端共 297/297，0 跳过。

删除只读 GET 的 raw-save 游标保留分支后，反例测试实际失败；finally 恢复并核对源码哈希。site test 类型、Astro check（238 文件，0 errors、0 warnings、11 hints）、9 文件 Biome 和 diff check 通过。未在本单元重复构建完整站点，实际编辑入口接线后再做完整构建/浏览器组合。

实际审查 API capture/status、runner、公开确认、batch、journal、草稿/创建消费者及恢复 UI。文案明确“客户端协议”，不把它写成已切换表单；无 SDK/环境/部署变更。编辑入口及浏览器测试、最终制品矩阵、历史审计、test 三时钟/20 件恢复/COS/MVCC/性能和旧诊断缺口仍需继续。
