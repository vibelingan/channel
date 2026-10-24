# P3e6c2a 公开图片按有效引用数量放行

状态：公开兼容读端本地实现与验证完成。基线ae8f6fd。真实pending/proof producer仍关闭。

## 运行边界

getCatalogImage目前只读原publishedRefCount；未来分阶段发布后，基数0但有已提交+1时会误拒，基数1且已提交-1时会错误放行。因此catalogPublishedReferenceLedger非空时，必须用C1同一快照原语读取图片及全部提交证明，按effectiveCount决定可见性，并采用该快照的整张图片metadata；不能混用首次读到的status/storageFileId/data与后来的计数。

没有ledger字段保留现有单get/原计数与legacy缺counter扫描规则。已结算为空且完整schema/epoch/计数验证通过时，同一image行已经是一份完整快照，也保留单get；不能只检查pending.length等于0就忽略损坏。仅非空ledger进入proof事务，不给所有图片永久增加事务。placeholder按明确ID的既有例外继续公用。ledger存在但损坏、缺计数、证明读取失败或adapter未实现快照时拒绝公开，不能改用原基数或legacy全表扫描；服务端记录有限错误码，HTTP不返回proof/root/ledger/私有storage信息。公开图片读取保持0业务写入，结算由专门路径负责。

## 退出检查

实际JSON快照+真实本地文件字节+HTTP适配器，三支持provider形状覆盖已提交+1、已提交-1、未提交差值、共享多operation与80项；坏proof/ledger/counter、服务失败/缺能力拒绝，0fallback/0存储读取。无ledger旧路径与placeholder不调用快照。首次get后metadata变化时采用完整snapshot，错ID拒绝。所有图片原public MIME/nosniff/CSP/header和private blob预览边界不变。后续旧counter/删除/回填/writer兼容仍未完成，不启用真实账本生产或宣称最终发布修好。


## 实现、回归和review

index增加内部readCatalogImageReference facade，复用C1 strict命令及可选adapter方法，缺能力明确抛错。handler仅在ledger存在时验证空账本快计数或进入只读proof事务。emptyCatalogImageReferenceCount完整验证schema/成员/epoch与空账本基数，null明确表示需要proof；不能用真值判断把count0当pending。非空路径采用snapshot整张metadata+effectiveCount，拒绝错state/错ID/非法计数/报告已经写过的read。初次get也核对imageID。失败只记opaque imageID及有限安全code，不记error对象/私有URL，返回通用404且不回退旧基数或legacy扫描。没有新的公开JSON字段。

先红：首版HTTP夹具漏传config，TypeError保留为夹具错误；补config后24中20业务失败才是有效红测。接入后badproof测试仍失败，核对发现构造了另一root的proof ID，原pending实际没有对应proof，所以允许基数1是正确行为；改用fixture真实plan ID后拒绝，未改变产品规则。新增空账本count0/1单get、共享+/-相抵、snapshot/body/status、损坏返回与日志隐私，最终44新增全部通过。真实JSON文件、实际本地存储字节、生产HTTP adapter，覆盖三provider形状；cloudbase-storage形状的字节仍由本地存储adapter提供，不称为真实COS下载。

19源码反例检出122重叠失败，四源文件finally SHA一致。覆盖绕过snapshot、旧基数/旧metadata、错state/ID/小数/settled结果、错误时旧值fallback、私有错误及code日志、0真值误判/无谓事务、placeholder误拒、空账本漏校验、公开read变settle、仅采用首个共享proof。共享+1/-1净0必须私有，基数1的-1/+1仍公开；没有只用全为正数的样本验证“全部计算”。

实际Node20编译HTTP+生产adapter、installed Node/WxSDK11组，仅SDK HTTP传输替换：初次image get在事务外用于选择路径，非空ledger随后image+proof同一真实transactionId；已提交+1可见/-1私有、missing proof不激活、读0写、坏proof0字节访问、有效空ledger及无ledger1get/无事务。该探针的媒体字节是受控adapter，真正本地文件字节另由44单元测试覆盖；不假称vendorMVCC或云存储成功。

当前相关DB1732/public175共1907全通过，实际Node20同样1907；19包types/E2Etypes/Astro216零error/warning、8既有hint，standingSDK通过。未改admin/local/sync/site/scripts的业务源码，本步不重复记成完整UI或整仓组合验收。四源码/测试文件显式Biome/diff通过；精确3函数/site产物在提交review后验证。

实际review handler、index facade、store快路径、44测试及本步/实施/SDK三文档；核对Public API Projection/Content Validation与既有HTTP测试、C1SDK事务sender和字节adapter。具体措辞把“有ledger必须事务”改为“非空才proof事务，有效空ledger用同一image行快照”，与count0/1零事务断言对应；避免把本地减少请求数说成实测P95。全体旧counter/删除/回填/writer尚未兼容，最终producer与原formal P1未完成，fullDeliveryReady=false。


### 提交审查补充：计数字段须为自身字段

069a2e3初审以两条HTTP业务红复现了非法adapter返回下的遗漏：counted snapshot删掉own counter且effectiveCount为0，或空账本图片只从prototype继承counter1，会触发legacy扫描并返回200。真实native/JSON adapter的C1读端已检查own字段；消费者仍应闭合这层fallback。handler现在要求counted image有自身publishedRefCount，空账本快读也明确要求own counter；两条由200expected404转绿。两个独立删guard反例再次使它们失败。最终44新增/19反例122重叠失败，DB/public1907、Node201907、19types/E2E/standingSDK均在修复后重跑，SDK基线重新编译11组通过。保留初审P2和修复证据，不将错误返回夹具描述成现网观察。
