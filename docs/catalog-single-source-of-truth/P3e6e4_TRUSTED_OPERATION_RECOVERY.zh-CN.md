# P3e6e4 原操作可信恢复

基线023231b9。内部 operation-recover 绑定原productId/operationId/rootId/inputDigest，只允许当前有效admin。旧owner、原根和终局均从服务器读取。健康操作返回只读not-needed；仅过期、原owner缺失/撤权或原输入失效时永久取消，不能接管继续其发布。保留原owner、保存结果、媒体、配置页与引用，只在原根首次取消写中增加当前请求者actor/reason/at审计，并原子写同一cancel proof。精确重复already-cancelled不改审计、不写文件；complete核对原commit proof后只读already-complete。未来时间、坏codec和冲突终局拒绝；未知owner查询错误向上返回，不猜成owner不存在。

## 时序、预算和失败恢复

资格检查后的异步读取可能跨过TTL或遇到时钟校正。先在资格读后复核，再在取消的最后product/proof读后、任何写入前复核。取消时间和审计时间取同一个最终值。增加的审计受原1MiB根预算控制，没有第二个状态根、锁、临时计数或新provider方法。过期/撤权恢复不依赖已坏supplier，商品、图片内容、类别和其他root不变。

实际安装NodeSDK3.17.2/database1.4.3的Node20探针441项通过；保留原399并加42。raw与生产adapter过期6、撤权7、输入失效11个文档操作；重复4读0写。全部读取与原根/cancel proof两写属于同一实际SDK transactionId，读在写前。六种根/proof坏ACK分别整笔回滚再重试，提交已生效但确认丢失后只读恢复；暂停实际startTransaction后改调用对象不会改原输入。coded及malformed owner响应由安装SDK抛错，零写并回滚。HTTP传输替代不证明真实供应商MVCC、COS或P95；官方首次读快照/100操作/30秒仍是上线前实际验证项。

## 测试与独立反例

新增48项：DB40、JSON8。最初23项中14业务红、9拒绝正控；随后两个资格读取时钟反例先红。review又发现取消末尾product/proof读取窗口，两个新反例先红后修。最后相关394项、全量5633项、实际Node20关联2645项均0失败/跳过/取消。19工作区types、E2E types、standing SDK、四文件Biome和diff检查通过。三个测试union类型错误通过实际record分支收窄修复，没有削弱生产类型。

最终源码30项故障注入全检出，85个重叠测试失败及3个SDK-only反例，四源码SHA恢复。原R1的单独product/op比较删除被canonical根key校验覆盖，改成同时移除对应key绑定后检出。R2单独移除负age判断时，expired的age<=TTL仍拒绝，所以没有把零失败算作检出；最终末尾资格保护整体移除，两种末尾读取时钟反例均失败。历史日志保留，最新r2-proof只包含已实际检出的30项。恢复后441SDK和394相关控制再通过。

JSON实际80个私有暂存root填满同一图片：第81个原操作页报MEDIA_BUSY且零文件变化；当前admin可信取消首个已失效root，原第81操作/游标续接成功，79个其他pending保留、加新项仍80，effective0、无commit proof、商品未发布，分类字段值与存在性不变。不是80个客户商品或自动后台清理。磁盘失败、写成功丢回应、两个恢复者/原owner取消竞争、重开零写、输入捕获均覆盖。

四个独立Node24/20进程使用真实compiled worker导入并保护24x16 PNG：私有暂存404，健康检查0写，控制夹具原根过期、另一admin恢复、丢回答后重开审计，旧owner不能续接，C1结算0且私有PNG SHA/尺寸和分类保留。采用独立无owner快照，父owned文件未改，夹具最终删除。当前混合编译产物来自023231b，JSON持久化为当前源码；精确SHA三函数/site及进程检查在提交审查后补记，不能把混合检查冒充新产物。

## Review与后续

人工检查两生产/两测试及四记录文档，沿native/JSON输入捕获、事务ACK、原权限分类fence、C1与terminal读写、旧owner取消/完成/删除握手追踪。native和JSON生产整文件未变，原save actor/classification fence未改。文案把“恢复后能发布”改为“原操作永久取消，新的有效操作另行发起”，并区分元数据、真实PNG、混合产物及客户验收。没有unsafe formatter；已知precommit lint --silent错误输出不计验证。

这是内部恢复内核。后续仍须有界server caller选择真实满槽失效root、接口/UI恢复、live编辑与review receipts，再整体组合和test实际验收。未接通的helper不称后台自动清理。原tests/e2e/admin-subcategory-visibility.spec.ts:1218整笔发布丢回应P1、真实云/P95、三时钟resync/load/Edit/Preview和20件保留分类发布后回退仍未完成；客户producer关闭，fullDeliveryReady=false。
