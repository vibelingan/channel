# P4c2：无正文恢复指针的停止接线

实施中。保留已通过的空patch恢复/继续/停止，不把正文存入localStorage。对于原任务GET明确NOT_FOUND、无绑定digest、无可重放空输入的指针，Stop调用P4c1的原子停止协议；返回仍须经过原product/operation/intent校验与原任务读回。未知网络、错误身份或绑定过的Root缺失均保持未决，不猜取消。

用实际Admin/Public/JSON/PNG组合先验证含私有编辑的start未到达、刷新仅剩pointer、Stop成功/丢回复/请求未到达后再停，以及原start恰好先到达的竞争。商品内容、分类和图片保持原样；不发continue、不造新nonce。已有20件发布/创建/分类组合回归继续保留。完整编辑保存及live刷新仍在后续接线，当前不部署。

## 本地验证（2026-10-20）

新增客户端Stop严格指令，额外正文/版本字段和非publish intent在发送前拒绝。只在明确缺失、无已绑定digest、无可重放空输入时调用原子Stop；回复必须符合原身份且为取消/完成，再读取原Root确认。已绑定过的Root后来缺失，不生成替代取消记录，保持未决。旧空输入、已存在Root、未知网络和其他身份路径保留。

实际Chromium与390px WebKit用真实组件、Admin/Public/JSON/PNG验证刷新后停止缺失的私有编辑请求，正文不进localStorage，商品原样、不重放start、不调用continue、只停原ID；连同旧表格20件、账号、刷新/下架恢复共22项通过。扩展实际客户端/服务端组合覆盖Stop丢回复、Stop请求未到达后二次停止、原start先到、坏ACK与绑定记录丢失。Node20相关117项通过。全site1249通过/0失败，1个环境开关图库项已显式再跑1/1；Astro实际构建15页及构建表格20件恢复1/1通过。5文件Biome、类型检查通过。

两个源码故障（忽略已绑定digest、接受未完成Stop回复）均被真实断言检出，源SHA恢复。失败与测试类型纠正记录保留；没有放宽生产schema。证据见`private-input-stop-verification.json`。这完成Stop接线，尚未把完整RecordForm保存和live刷新迁移到原生协议；未部署、未改真实数据，fullDeliveryReady=false。
