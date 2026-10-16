# P2f5a：准备来源图片的批量查询

状态：读取单元已完成本地验证；fullDeliveryReady=false。实际worker需要反复读取完整候选。现有readCompleteAlibabaDetailPlan按8路逐个get catalogSourceLinks，每105张图片要105个点读；改为最多100个确定性_id的in查询，单图helper保留单点读。复用已经存在的backend list、两adapter过滤器与SDK命令，不添加假方法或改源数据。

每个URL仍按原策略解析、保留旧CDN映射、只把alicdn HTTP转换HTTPS查绑定；不抓取URL。批量返回要核对_id/provider/sourceUrl，只把原计划所需图库或配置图片采用。缺失/失败绑定仍按原诊断处理。不能用count/get跨请求相等作一致性断言，因为同步可能在二者之间增加合法绑定；只消费实际返回的限定ID集合，后续当前输入和最终计划校验继续生效。

红测：105/205来源映射批量查询数量、完整采用集、异常provider/url/id、缺失和失败状态、URL别名/旧域名、无写入。真实JsonFileAdapter已存在的source/manual租约候选小流程也要回归。批量只优化读取，不把结果当像素证据、ready或发布许可。worker入口/进度与最终目标保护继续。

最终证据：86候选/租约组合、96 Node20组合（含10真实文件审批成本/公开读回/恢复），8实际源码故障检出、41–85正控且0跳过/取消；源文件finally恢复。105/205照片完整采用，两批/三批查询；显式_id排序，不依赖createdAt。每批经过现有backend list，CloudBase list本身执行count及get，不能称每批仅一个RPC。

最终广泛admin545+local352=897，0失败/跳过/取消；四后台types及最后两consumer类型、5文件Biome、SDK106通过。第一轮local失败1项是旧成本断言106次点读；修订为每请求2批/0点读后先跑10项实际审批，再重跑全套通过。最早76项组合错写local路径未包含那10项租约测试；修正路径后86项与8故障全部重跑，旧76不冒称完整组合。仅移除HTTP赋值的故障被上游URL规范化防线覆盖，不计检出；实际绕过完整URL规范化后相应红测失败。

实际复核来源helper、两个adapter的list/filter/sort、只读fixture、inspection与审批缓存测试，文字将“批量一次调用”改为“批次”，保留RPC与业务验收边界。无新vendor方法/shim、云资源/业务写入或发布动作。实际worker接线继续。
