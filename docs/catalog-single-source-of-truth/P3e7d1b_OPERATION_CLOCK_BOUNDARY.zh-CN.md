# P3e7d1b 原发布任务的可信时间边界

基线c0ddfd11。原JSON80一次begin失败的返回码没有保留，后续完整组合未复现，不能直接归因为时钟。此小MIU先作三类可区分对照：只偏移可信根时间、只改商品版本、只破坏prepared；记录begin返回码和原get的current/revisionCurrent/expired，区分同一CONFLICT背后的条件。

当前媒体签名 `catalog-preparation-authority.ts` 有5秒clockSkew，原 `catalog-product-operation.ts` 的保存/get/媒体/引用等阶段都对age<0拒绝。可信根时间由服务器生成，连续请求可能由不同执行时钟处理；这里不假设云厂商时钟精度承诺，以已有应用5秒签名边界作有界一致性对照。5秒外未来时间仍拒绝，原1小时过期上界不放宽。body不能提交createdAt，操作/actor/digest/来源/版本/角色/分类/最终证明等条件仍逐次核对。

先红：1/500/5000ms未来的原saved任务，当前商品和版本均匹配，却被标记expired、begin拒绝；与版本变化和prepared错误作独立控制。再覆盖原reserved保存、分阶段推进、取消与恢复、超界未来/真实超时拒绝、准备和最终写前复查。若确认为不一致，提取已有5秒常量共用，只将可信根的负年龄拒绝界改到该边界；不改租约时长/签名/权限/数据库资源，也不回拨或改本机时钟。

随后实际Admin/JSON/PNG用受控Date.now偏移验证原任务保存到发布的小流程与撤回；继续JSON80诊断/组合，不把注入复现当原现场根因。所有新断言在原guard下应真实失败，再做实现。新后端改动需要完整相关包/Node20、安装SDK、构建和精确产物验证。原UI/getter/P5和真实test门槛保持开放，fullDeliveryReady=false。


## 实施与复核

提取原媒体authority的5秒常量，原任务保存、get、媒体绑定、引用绑定/分页、最终发布、取消与恢复统一有限负age判断；NaN失败关闭，3600000毫秒有效、3600001毫秒真实过期。未改变签名有效期、1小时寿命、事务写数、请求DTO、角色/版本/来源/分类或SDK表面。三个诊断对照可分别产生可继续、版本CONFLICT、prepared的VALIDATION_ERROR；原JSON80现场原因仍未确认。

16条DB新增和2条实际Admin/JSON/PNG新增先红再绿。完整相关7包与脚本6298项通过，Node20完整相关组合3331项通过，无失败/跳过；19包类型、E2E类型、既有站点测试类型、5文件Biome及CloudBase合约检查通过。0/105SKU在受控Date.now偏移2000毫秒下实际发布、公开同revision/名称/SKU读回、实际撤回，原分类保留，公开详情/PNG恢复404，有效引用归零；未改主机时钟。原JSON80两个用例所在的188组合通过。13次顺序故障注入触发18个重叠失败并恢复两个源码SHA；包含恢复最终finalAge漏检的单独控制。首次476组合的晚恢复检查1失败已修复，完整476复跑通过，旧失败日志保留。

安装SDK复用原651控制并加6条独立时间对照，共657通过；两种实际安装SDK路径验证未来500毫秒可继续、未来60秒/真实过期不可写，最高98文档操作。HTTP替身不证明真实云MVCC/时钟保证/COS/性能；初次启动遗漏bundle参数是无测试启动错误，修正后r2日志完整保留。

实际review/simplify核对三个生产文件、两个测试文件、媒体签名、取消/恢复和get所有age及finalAge检查、图片删除的未完成根保护。未来根仍被保守保护；body不能注入createdAt，失效actor不能借容差继续。humanizer核对本记录及IMPLEMENTATION_LOG，把“定位了JSON80原因”改为“独立复现时间边界不一致”，保留未确认现场与本地/云端证据区别。

下一步在精确SHA构建三函数/站点并独立进程验证后，继续短暂CONFLICT同原scope复查、共享队列及既有UI接线。JSON80未明原因、原正式UI P1、会话getter/P5及真实test验收门槛仍开放，fullDeliveryReady=false。
