# P4c1：原请求未到达时的原子停止

实施中。这是完整编辑接线前的恢复缺口：编辑请求含私有正文，浏览器不能为刷新恢复而保存整份正文。若start响应丢失且服务器尚无Root，现有空patch入口能用原版本重建空请求再取消；含正文的入口不能这样重放，也不能根据一次NOT_FOUND声称以后绝不会执行。

使用现有操作集合、原actor/product/operation ID和已有取消记录格式，增加`product-operation-stop`。同一数据库事务内：已有Root就停止其原操作（已完成时仅返回完成）；无Root则保存同ID的已取消空记录，阻止迟到的原start。它不提交空商品编辑、不保存私有正文、不导入图片、不发布，也不需要创建新集合或第二个审批状态机。原start和Stop竞争同一Root文档，只有一种顺序能提交；晚到的请求不能覆盖取消记录。

Stop携带明确intent，已有Root的intent必须一致；只作用于当前管理员自己的Root。旧的带digest取消协议继续保留。此单元先验证实际Admin/JSON、开始和停止两种顺序/并发、保存后的停止、媒体已暂存后的停止、已发布后的只读停止、重试幂等与角色/输入拒绝。服务端通过后再接入编辑客户端；不能把这个服务端子流程当作完整编辑已完成。

## 服务端验证（2026-10-20）

11条实际Admin/JSON用例通过，包含三种intent的未到达请求、Start/Stop两个顺序与并发、保存后保留文字、不同账号/intent隔离、暂存媒体取消、已完成发布只读、严格输入/撤权及缺失商品。已完成样本在finally内仅按本次operationId下架并确认D1恢复404。

数据库全量2254项、Admin全量638项通过；Node20相关141项通过，最终11条停止用例再次通过。Admin/local-server类型检查、4文件Biome、CloudBase SDK gate与Node20目标Admin build通过。没有新增SDK方法/类型shim/集合/配置。三个源码故障（不保存取消记录、忽略intent、误取消已完成操作）均被真实断言检出，源文件SHA已恢复。证据集中在`output/pricing-clock-repair-2026-10-13/p3e1/atomic-stop-*`。

这只完成服务端子单元；客户端尚未接线，未部署、未改真实商品，fullDeliveryReady=false。编写测试时暂存媒体fixture把额外inputDigest转发给严格Get而失败，已按真实Get契约只传product/operation；该夹具失败不计产品红测。其他首轮未知Stop失败是有效红测。
