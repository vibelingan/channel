# P3e6b1 同一操作的永久取消

状态：本步局部验证通过；内部持久命令，不开放新HTTP/UI。基线b4874b6。保持一个root/一套状态机，不引入第二个图片锁。

## 现有行为与复核修正

runProductOperation目前只能start/get/begin/page；旧请求在同一product/source版本恢复后仍可能继续。未完成审批的图片hold只有staging+createdAt过滤，没有明确取消回执。新的分阶段媒体协议需要一个不可逆的停止点，不能只在浏览器停止后续请求。

完整复核index.ts发现原删除入口已经使用APPROVAL_JOB_MAX_AGE_MS一小时加APPROVAL_JOB_DELETE_MARGIN_MS十分钟；此前“大媒体讨论中不能只按一小时释放”是设计条件，不能冒称现有入口无余量。保留原期限和余量；本步不把它改成无限期hold或新增expiry状态机。平台30秒上限与跨运行时事务/时钟仍须vendor验证。

## 数据形状与边界

内部operation-cancel(productId,operationId,inputDigest)，原actor仍须当前admin。相同原根增加operation.cancelledAt为服务器ISO时间；保留state/createdAt/operation输入、saved回执、prepared publication和不可变SKU页，不撤回已保存草稿，不把取消说成业务回滚。optional缺字段的所有旧根保持原行为；存在但无有效时间的标记视为损坏，不能恢复活跃。marker一旦存在，在相同input恢复、source/分类/权限恢复、重复start/get/begin/page/save时都不能重新推进；新操作需要新的operationId。

取消只改变自己的根，不能改产品、他人根、分类或图片计数。可取消已过期、source改变或产品已消失的旧操作，不需要旧内容再次通过发布检查；撤权/错actor/错ID/错digest不得取消。重复命令0写、保留首次时间。成功回执只证明停止，不能假装发布/下架成功。

读取actor/root/product元数据后写root，预算4文档操作；不为取消读取supplier来源，也不允许写后再读。原job strict decoder保持；命令按原inputDigest、actor和root确认归属，取消时间由服务器写入；原inputDigest不随取消改变。最终finish尚未启用，后续必须复用同一current检查，不能用legacy decoder投影。

## 图片hold接入

native现有and/exists/expr查询增加operation.cancelledAt不存在条件，仍仅回传两个ID、limit1、一读零写。JSON与旧adapter分页fallback复用同一个取消识别，保持时间边界与gallery9/description18/SKU全部参考语义；取消自己的根不能放行其他preparation/job/product引用。公开图片门禁不变。Exists是安装SDK的既有方法，正式查询序列化需在Node20已安装SDK发送端验证。

## 红测和退出条件

reserved/saved/staging+已暂存页逐阶段取消，原内容和回执不丢；start/get/page/begin/save不可再推进；重复丢结果后查询/取消0额外写；来源坏/版本变更/商品缺失仍可停止；权限/actor/digest拒绝、坏写ACK回滚、SDK启动等待前冻结、JSON多进程重开。三种图片引用取消前保护、取消后仅本根释放，其他root/当前商品引用继续保护；native/JSON/分页fallback一致，查询仍小投影；原TTL+十分钟余量保留。每步红绿、故障注入、review及Node20/全量/构建按影响复核。

本步不是完整用户取消UI、后台自动恢复、媒体seal或发布finish完成。原formal P1、vendor/P95/test部署/真实3时钟及20件验收保留，fullDeliveryReady=false。


## 实施与验证

原根增加optional operation.cancelledAt，不另建记录或锁。新命令复用完整等待前捕获和真实事务/JSON文件锁，actor/root/product三读后仅根一写。重复0写、首次时间不变；get/start返回历史current=false，begin/page/save不再推进；old save在加载source之前即停止。取消未改变产品/分类/计数或已暂存SKU。修正历史产品缺失且原updatedAt为null时revisionCurrent误为true的元数据边界。

三种图片查找均使用标记存在性而非真值；null/undefined/数组嵌套等损坏形状不能在一条路径漏出保护而另一条恢复活跃。Strict根拒绝无效标记；native$where新增exists(false)，JSON和旧adapter分页fallback同语义，其他root继续保护。原一小时+十分钟未改，65/69分钟仍保护，71分钟不保护已过期根。这里释放的是本审批hold，不是当前产品或其他preparation的引用；没有把“可删该图片”当成取消回执。

先红：11新取消场景中7个正向/写失败场景在缺少命令时业务失败。最终55新增（DB43/local11/admin1），取消相关337聚焦通过。覆盖reserved/saved/staging/已暂存页、坏来源/过期/商品消失/已被他人上线、wrong actor/digest/权限/客户端时间拒绝、永久标记与原草稿/回执/页保留、当前数据恢复也不复活、new ID可重启、JSON save/cancel与page/cancel并发。没有把内存旧对象当作持久状态：已上线保存检查读取真实rows结果。

20取消源码反例检出156重叠失败，另一个仅由真实SDK检查发现的取消后多读source问题；四生产文件finally恢复SHA一致。Node20实际安装SDK仅HTTP替换：11组，取消4文档操作/读先于写、四阶段、实际SDK启动延迟后输入冻结、三种坏ACK回滚并重试、已提交却commit确认丢失后查询/零写重复、坏source取消及撤权拒绝。Node+wx+生产adapter另12组实际发送参数，新增取消条件准确、limit1/两个ID/一get/零count写。四独立Node24/20进程丢弃取消答案后重开，保留20私有配置，旧begin/page/save拒绝、重试文件字节/mtime不变，fixture删除。不是云MVCC证明。

全量首次检出admin流式超时测试失败，637中1条（received0 vs expected1）。保留首次失败日志；五次隔离原样通过，可控180ms SDK启动延迟在80ms总截止下复现同一断言，说明原流式测试错误地假定超时时请求必已到服务端，不能据此认定取消逻辑改坏。修正测试先建立真实流式响应，再检查硬截止早于受控完整响应；另测整个SDK启动阶段也在总截止内。保留80ms测试预算，生产8秒代码逐字未变；删去受宿主调度影响的300ms断言，改为必须已收到流式字节且完整响应尚未结束。将硬截止故意放大十倍后实际流式测试失败，恢复SHA，再Node24/20各15条通过。没有把收到0请求改为通过或跳过测试。

最终七包+scripts4931=309/1637/638/627/131/304/797/488，fail/skip/cancel0。Node20全DB+三相关JSON文件1742，另invoker15；19包types/E2E/Astro216零errors/warnings、8既有hint，超时测试修正后admin types再跑。11文件显式Biome/standingSDK/diff通过。原native/JSON adapter及超时常量逐字未改。最终精确SHA函数/site构建与mandatory smoke在提交review后补证。

SDK边界：没有新库、SDK方法或shim。exists是原SDK已有方法；对应官方exists页面的MCP Markdown不可读，网页抓取也不可用，未冒称文档确认。已核对installed database1.4.3 command.js:39、command.d.ts:17与Node3.17.2/wx4.0.2真实wire。Context7不可用。后续provider执行/并发/P95仍是硬门槛。

实际review四个生产文件、七个测试和本MIU/主媒体协议/IMPLEMENTATION_LOG/SDK-PROBE；明确cancelledAt不在原inputDigest内，以命令归属校验和服务器时间保护；人工措辞从“取消回滚”改为“取消停止后续步骤”，用原产品/分类/已暂存行/首次marker不变的断言核对。对十分钟余量的前述假设已按真实源码修正，未把设计条件写成现网缺陷。整体验收仍未完成，原正式丢发布响应P1与fullDeliveryReady=false保留。


### P3e6b2核对更正

4cf5101的SDK绿色归档未覆盖最终invoker新测试名与门禁旧名称的组合；本轮实际门禁因此失败。此前“standing SDK通过”不能视为该SHA的完整证据。P3e6b2已同步两项测试名和最低15条、保留实际失败，再用硬截止十倍反例确认门禁拒绝，恢复生产源码并重跑通过；生产8秒逻辑未变。其他已记录测试计数/产物不据此变成SDK门禁通过，真实云验收仍未完成。
