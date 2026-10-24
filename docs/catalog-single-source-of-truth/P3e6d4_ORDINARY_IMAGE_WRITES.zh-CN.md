# P3e6d4 普通图片写入与旧计数回填

状态：创建/更新守卫与旧回填修复已实现，本地最终回归通过；基线e06829d。真实pending/proof producer仍关闭。

## 可观察问题

backfillPublishedRefCounts把商品真相tally直接SET到base。base0+已提交加1的图片本来effective1，回填base1后变2，随后旧减1仍剩1，会使取消发布后的图片继续公开。单纯在扫描时跳过ledger还不够，扫描与写入之间可能有producer附加ledger；必须在图片写入的事务/JSON锁内再次保护base。

## 数据与约束

沿用images.publishedRefCount和catalogPublishedReferenceLedger，无新持久状态/SDK方法/锁。普通create/createDocWithId/update/upsert与持Alibaba租约写入禁止写ledger字段；它只能由专属根协议事务创建/修改。无ledger的显式counter写可用于旧数据审计回填，但必须安全非负整数。已有ledger时普通counter只可保持与当前base相同，不能重设；实际增减/结算继续走d1，不得经此路径绕过。普通metadata patch保持count/ledger，这些创建/更新入口的图片输入在异步前复制，避免晚添加受管字段。

update图片的受管字段需native同事务pointget/严格ACK写入，JSON沿既有锁；upsert/租约写已在事务内，保持原租约写fence、读在写前和其他collection行为。普通metadata更新沿既有patch语义，不重建账本或读proof。新图counter0与缺counter legacy均保留；createOnly只在真创建时检查，不能用未应用的默认值误拒既有行。

```ts
assertOrdinaryImageReferenceWrite(current, appliedPatch);
// Ledger writes forbidden; a managed base cannot be overwritten by an absolute tally.
```

## 回填与回退

扫描到任意ledger（含空/坏）均跳过，不猜修复；结果显式报告managed-reference跳过项。写入时专属冲突也记skip，供应商错误保持失败，不假称成功。并发消失的图片不能记成已修复。旧无ledger的绝对SET仍要求原有quiescent维护窗口，不把本步说成全目录原子审计；专属ledger修复需核对根/证明/商品真相，不能由旧全表计数覆盖。

拒绝仅扫描快照guard、重置epoch/丢pending、先结算再盲SET、全局串行发布锁和改动所有catalog行事务。原产品保存actor/classification fence块保持，租约写fence不可省。其他普通图片metadata只patch其字段，后续inventory/review与测试验证不丢新字段。

## 检查

先用实际JSON适配器复现回填重复、回填后取消仍公开、update/upsert/租约路径覆盖及ledger注入；合法metadata、旧counter、创建和忽略createOnly作正控。随后pure/native/JSON共享守卫、写时race/提前capture/坏ACK、lease有效与过期、真实public读取、完整回归与Node20/SDK/构建。旧审批与最终根/证明原子激活、UI/历史/provider/P95/test及真实三时钟/20件发布回退仍开放，fullDeliveryReady=false。


## 新增入口与实际反例

接口清点发现createDocWithId也是图片创建入口。新建时同样禁止ledger和非法counter，已有行直接exists、忽略不会应用的payload；native新建set严格核对ACK。JSON三个实际入口反例先失败：保留字段被接受两项、等待期间输入变更一项。合法默认counter0继续可建；普通/租约update不能通过_id把图片移到另一个身份。

第一组12个真实JSON调用有10个业务红、2个metadata正控；保留错误public handler导入日志，不把它算业务红。保留路径4项先红；租约身份1项先红。最终新增59项：DB29（纯守卫20、native9）、local30。聚焦385通过，完整各包及Node20最终结果在下节补记。

20个故障注入全部被检出：16个测试反例合计96个重叠失败，4个只由实际安装SDK探针检出（生产update接线、upsert晚捕获、deterministic create绕过、全图重写）。四个源文件按SHA恢复。覆盖普通metadata/legacy误拒、非法counter、ledger/path/operator注入、managed base覆盖、写时ledger竞争、missing与未知供应商错误误报、输入晚捕获、身份变化、坏ACK。首版注入器将预期SDK业务错误只认作AssertionError，分类器因此失败；日志明确是ImageReferenceWriteError，修正为识别该确定错误后完整20项重跑，并重建137组绿色控制。不把脚本分类器错误计作产品问题。

实际Node20安装SDK137组保留之前66组，新增71组覆盖raw/helper与生产adapter、事务编号、局部更新数据字段、2docops普通update、既有租约fence、existing/createOnly/新建分支、3种坏ACK回滚、首个SDK start等待期间输入突变。错误name/code也按精确类型检查，保证backfill能认出managed冲突，不吞掉未知供应商错误。局部更新请求只含指定metadata及updatedAt，保留已有大私有data和ledger；没有为了guard整图重写。官方事务文档经MCP重读，Context7不可用；安装NodeSDK3.17.2/database1.4.3/wx4.0.2契约继续由实际SDK及standing gate核验。文档示例的data包装/返回wrapper没有照抄到本仓已验证SDK接口。

四个独立Node24/20进程持久化真实PNG、已提交加1proof及published商品，再执行backfill跳过/metadata更名/旧取消发布、丢弃最后操作响应、重开。重开确认product false、base0、epoch5、pending清空、proof保留、PNG仍为私有且public404；再次回填/读取0文件写，临时目录已删。这里只是隔离JSON持久化与本地HTTP handler，不能代表真实云MVCC/COS或用户20件验收。

实际review本MIU涉及的八个代码/测试文件及package出口、现有所有DbAdapter通用写入口和当前调用者；普通remove/条件remove、上传/保护与旧审批rawcounter/最终激活仍需后续review，不能把创建/更新保护扩写为全部writer完成。人工把初稿“所有图片输入”改为“这些创建/更新入口的图片输入”，与尚未覆盖的接口清单核对。现有产品保存actor/classification fence块在提交前逐字对照e06829d；不为此更改该块。未增加SDK方法/shim/依赖、持久字段、锁或对外HTTP结构。


## 最终本地检查

七包与scripts共5285通过：shared309、DB1860、admin638、local703、public182、sync308、site797、scripts488；实际Node20全DB/public及相关JSON2255通过。0失败、取消或跳过。所有19包types、E2Etypes、standing SDK、显式Biome及diff检查通过；precommit已知错误的--silent/PASS输出不作为检查证据。最终仅补充注释，准确说明ledger跳过和旧绝对回填仍须静默窗口，并重新执行故障注入/恢复控制。产品保存actor/classification fence完整块与e06829d逐字相同。精确提交的三函数/site构建及worker串联在提交review后执行，未因此声称部署或真实商品验收完成。
