# P3e4b 图片删除的定向审批保护查询

状态：本步局部验证通过，整体验收未完成。接续2b005d4。

## 问题与检查

unfinishedApprovalUsingImage原来按100行分页读整个job，再从publication找图片。新根还包含原始编辑与保存回执，大正文会扩大读回；单纯取publication仍可含10000个SKU图片ID。因此采用按待删图片在数据库过滤、仅回_id/productId的专用只读查询。禁止减少合法属性/图片上限、把分页改小或N+1点读正文。

DbAdapter新增可选findUnfinishedApprovalUsingImage(imageId,startedAfter)，两正式适配器实现。index先走专用方法；第三方/历史测试adapter保留旧完整分页回退，不能静默取消保护。native在原staging/createdAt条件之外匹配approved出版、同productId/header._id、图库前9/描述前18/SKU全部引用；where在limit之前，固定projection只有_id/productId，最多1行，不count不写。JSON在原锁内用同一现有catalogReferencedImageIds语义找第一条，文件读取机制不宣称因此变快。

官方Node查询field文档与command文档： https://docs.cloudbase.net/en/api-reference/server/node-sdk/database/fetch ， https://docs.cloudbase.net/api-reference/server/node-sdk/database/command 。Context7工具未提供。安装@cloudbase/database1.4.3 query.js确认field布尔转0/1并发送projection；使用既有expr/and/or/eq/gt，不增SDK类型声明。数组$in/$slice/$isArray在表达式里受类型保护；实际SDK发送参数还须验证。数据库服务端实际执行/race/P95留待P6授权，不能用传输模拟充当云验证。

红绿：真实JSON删除保护消费者list设为禁止，目标在100个无关job后，仍须找到；无关/过期/complete/错误header/正文同名图片不能误保护。新增与旧保护字段逐项对比；缺失和损坏回包failclosed；native where/projection/limit顺序与1次get、零count/写/全文点读验证。源码反例必须抓住漏SKU/描述/图库、漏TTL/state/header和漏projection等路径。保持旧fallback分页测试。

本步只处理删除前的未完成审批保护读取，不改计数、锁、finish或最终发布。后续仍需审批页/finish/最终visibility、真实云及20件发布回退。

## 实施与复核

DbAdapter可选方法接入index、native和JSON；原adapter未实现时仍走既有稳定分页。两现有消费者（admin abandon、sync worker discard）调用顺序未改：先查pending preparation/approval，再查商品引用，原图片互斥锁和refCount规则保持。native新增函数独立格式核对，整个saveCatalogProductInCloudBase（含原actor classificationAuthFence）与2b005d4逐字一致。没有新SDK方法、环境变量、表、写入或依赖；包export只暴露项目内共享查询合约，JSON通过工作区包路径导入。

专用where在limit之前匹配，图库前9、描述前18、SKU全部（包括第10000个），并核对publication.state与header/product归属。只投影_id/productId、limit1、一次get、0count/offset/全文点读/写。非法公开引用语法的旧imageId不会被任何合法审批引用，直接无hold，与旧读取语义一致；不把它解析成Mongo字段引用。SDK空数组显式无hold，畸形/多行/错误响应拒绝，防止继续删除。

3个实际JSON消费者红先复现全文扫描；新增61条最终通过，含100条以后的目标、旧fallback两页、24组独立Mongo表达式解释与既有引用语义比较、首尾截取边界、10000SKU和损坏回包。14个源码反例检出31个重叠失败：漏图库/描述/SKU、TTL/state/header、错误上限、截断SKU、遗漏projection、limit、绕过专用方法、错误ID语法、生产adapter未接线。3源文件finally还原且SHA一致；最后接线反例通过重新编译后实际SDK探针检出。

Node20实际安装Node3.17.2/wx4.0.2及生产cloudBaseAdapter共12组传输测试通过；只替换HTTP、禁止真实socket/fetch，逐项核对发送的query/projection/limit；错误/畸形回包failclosed，非法引用语法0请求。恢复源码后重新编译并跑正控，不使用变异残留bundle。

完整七包+scripts4784：shared309/DB1504/admin637/local614/public131/sync304/site797/scripts488，0失败/skip/cancel。Node20相关672；19包types/E2Etypes、Astro216项0error/0warning（8既有hint）、7文件显式Biome、隔离native函数格式/保护块、SDK合约、diff检查通过。原正式发布响应丢失E2E仍未修复，不计作这些局部绿色。

官方CloudBase MCP实际读取Node fetch/$in/$slice文档，安装database1.4.3源码和两种SDK实发参数交叉确认。Context7未提供；云状态REQUIRED/NONE，只查状态未发起授权。实际云端谓词执行、查询计划/索引、P95和race仍必须在P6授权后验证。减少回传是已验证事实，云端耗时尚未测量。

迭代脚本的导入位置写错、负例同时残留另一图库引用、初次limit变异匹配了两个函数，均保留失败日志并改正，不算业务红。提交后补同一SHA产物验证。

文字核对：实际审阅8个实现/测试/包export文件及本MIU、IMPLEMENTATION_LOG、SDK-PROBE，另追踪admin/worker调用点；把“返回图片清单”纠正成“只返回两个ID”，以两SDK和真实adapter发送projection核对；把“变快”改成“减少回传，云耗时未测”。原始属性和同步正文没有截断或删除。
