# P3e7c2 实际 Admin 开始与绑定草稿保存

基线536b20a6。上一 MIU 完成原提交/服务器补全冻结、精确产物及12进程检查。本步接实际 Admin start 到原 withAdminEditsKept（仅 Changed/Removed 编辑），并增加只接受 productId/operationId/inputDigest 的 product-operation-save。浏览器不能再提供另一份 patch 或内部 expectedOperation。服务端读回原根，只用根中完整冻结的 values 调用现有 saveCatalogProductWithIdentities，保持操作者、版本、来源、分类、身份、TTL、取消和新照片准备门槛。

保存请求不发布。save-draft/publish 意图可保存未发布草稿；live/下架/归档意图仍需各自后续流程。已保存/暂存/完成的同根请求只返回真实历史状态，不能重写产品。保存成功但回应丢失后，查询或重试返回同一 saved 回执；若产品后来改变，current/revisionCurrent 必须如实反映。未知 I/O 抛出，不用 published:true 或一个陈旧产品推断成功。

新 save 返回沿现有4096字节白名单状态，不返回 patch/来源/大产品。无分类可以保存草稿；身份重复/非法值/新照片未准备返回有字段和 edit remedy 的现有 catalog issue。slug 加入现有安全字段名白名单，以便用户定位 URL 错误；不暴露被拒值或内部错误消息。没有新的 DB/锁/SDK方法或开关；实际 Admin 仍受原鉴权和 enableDetailApproval 保护。

先用实际 handler+JSON 的失败测试覆盖原 helper keep 决定→冻结→绑定保存、同原请求重放、真实身份规范化、30k描述、无分类、错摘要/他人/过期/取消/撤权/并发版本/新照片、双击和提交回应丢失→重开查询/重试零写。再实现，逐步跑相关与组合测试、review/故障注入/实际SDK、类型构建和精确产物。旧 updateRecord/分类/发布流程的行为与鉴权保留，身份规范化实现改为共用，尚不切客户UI到新producer。

原 UI P1、完整 continue/live候选/新照片/审阅回执/DataIssues/真实provider/P95/三时钟20件发布回退仍未完成，fullDeliveryReady=false。


实际入口首轮发现身份规则缺口：原 adapter 只规范化占用键，网站字段依赖 Admin wrapper 预处理。现在将原纯规范化规则提取到 shared，旧 wrapper 与公开 start 共用；原提交摘要仍绑定规范化前用户原稿，normalizer 仅可补决定。旧根的严格原稿摘要也可只读重放；非规范身份的旧 reserved 根禁止新保存，返回 reload 提示，避免借新入口写入带空格 URL。新开始会生成规范字段；已有 saved 历史只读。正常 SKU 规则为小写，最初测试误期望大写已按原规则修正；带空格 URL 被写入的反例保留并修复，未改成接受坏值。

内部元数据余量从1024增至2048字节，仍不扩大公开256KiB请求。原因是冻结时增加身份规范化：slug最多120 ASCII字节，SKU最多120 UTF16单元，按每单元最坏JSON转义6字节估算720字节；即便把两字段完整输出840字节都算新增，加原决定/摘要475字节共1315字节，仍小于2048。该独立上界不依赖具体Unicode版本，也不储存额外patch；原512KiB/1MiB根上限继续执行。


## 当前结果

本 MIU 已实现实际 Admin start 的 keep helper 接线和 product-operation-save。保存只从原根取冻结 values，经现有原生事务同时写商品/身份和 saved 回执，再读回4096字节白名单状态。不会批准或发布；publish意图在本步也只保存草稿。保存回执已存在时返回历史事实，不再执行保存；current/revisionCurrent 与历史保存状态分开。错摘要/他人/取消/过期/撤权/并发版本变化均不写入。新照片仍须走后续准备，返回字段提示；未用放宽照片门槛换取通过。

| 读到的原根 | 本次保存行为 |
| --- | --- |
| reserved，当前且有效，save-draft/publish，规范网站身份 | 按原版本与服务器 expectedOperation 原子保存，随后读回 saved |
| reserved，取消/失效/过期/撤权，或 live/下架/归档意图 | 拒绝，不写商品 |
| 旧 reserved 含未规范身份 | 保留原稿，返回 INPUT_CHANGED/reload；需新操作，不能偷偷改冻结内容 |
| saved/staging/complete 且同 scope/digest、未取消 | 只读返回原事实；不能借重试覆盖后续编辑或重新发布 |

新增37项：shared1、实际Admin+JSON36。555串联测试、5788整包测试（shared327/DB2192/admin638/local856/public182/sync308/site797/scripts488）与2823实际Node20相关测试通过，均无 fail/skip/cancel。Node20新增覆盖整个shared产品身份与旧Admin身份保存测试。19workspace类型、E2E类型、standing SDK、11文件显式Biome/diff检查通过。包括管理员实际 keep→冻结→保存、正常30k描述/无分类、URL/SKU规范化/清空/冲突字段、原稿与规范文本区分、旧根只读、publish意图只存草稿、保存丢回应→重开查询/重试零写、双击、保存和取消竞争、保存和另一个原版本编辑器竞争。两种满256KiB容量控制保留原参数和Unicode扩张参数；此容量证明不等于新照片已可保存或发布。

实际 SDK 探针518项保留此前498项，新增20项经真实Admin模块→DB index→原生适配器，只有HTTP替换。六种商品/回执坏ACK导致整笔保存回滚，重试成功；真实保存提交后丢commit回应，可按原根查询恢复。包含身份规范字段、来源变化后不重算、错摘要/权限/版本/取消/注入与历史结果零写。普通无新照片草稿保存是3笔事务，各3/7/3次文档操作；不能把13次合计当成一笔事务，也未测真实网络P95。原全套单事务最高98次文档操作仍受控。无新SDK方法/shim/依赖/env/表/锁；Context7不可用，已有官方事务与安装包source/types核对继续适用，真实provider首读快照/冲突和COS未验证。

最终9组关键故障注入：7组针对子集测试产生33次重叠失败，2组SDK-only均在498项此前控制通过后，分别因实际Admin normalizer脱线、原生expectedOperation缺失而失败；四生产文件SHA恢复，518探针重建后通过。其余覆盖DB save脱线、返回保存前状态、历史保存被重做、额外patch注入、无normalizer入口漏规范化、旧Admin身份wrapper脱线、旧未规范根被保存。最初SDK缺字段直接解引用引起TypeError，改成明确存在性断言后才计作有效检测。一次无normalizer故障未被旧测试捕获，因此补了独立facade开始→保存→原稿重放/不同原稿冲突控制，再完整重跑最终矩阵；未隐藏幸存故障。后加两项竞争组合未改变生产源码，由最终整包/Node20另验证。

开发中的装载/夹具/类型问题单独记录：最初测试误用未导出catalog-source包路径，修正为既有catalog-import/observations后12项业务红测确认缺口；首轮实际保存发现带空格URL未规范，已复用旧规则修复。SKU期望大写不符合旧小写规则，修正该夹具；旧并发normalizer测试闭包拿原稿而未使用提供的规范patch，改成只给该patch补决定，保留禁止改其他字段断言。Unicode㌖重复24次实际展开144字符，正确被拒，改用20次恰好120字符的合法容量夹具。几处测试联合类型和命令字面量已显式收窄；13项多const声明按AST分拆，没有unsafe formatter或any绕过。一次临时Python前缀语法错误没有执行补测，随后用脚本重跑；不计作功能红测或已完成补测。

review/simplify/humanizer人工检查11代码/测试及本次四份记录，交叉核对实际supplier helper、旧身份错误/空值语义、根codec、原生/JSON事务、源快照、取消proof与白名单状态。将“底层会规范化字段”纠正为“底层只规范占用键，原Admin预处理字段”，以真实失败和共享函数验证；字段/数量/容量/三个事务的事实均与日志对照。保存和发布、历史结果和当前状态、受控HTTP和真实云的边界保留。原生adapter/JSON/旧approval workflow逐字等于父提交，原分类与actor/source门槛不变。

提交后立即按精确SHA内联review，并构建三函数/site与12进程PNG组合。新物理组合用编译Admin完成第二个真实操作的start/save，暂存后重开再次save只读零文件写入，再原恢复/取消/C1结算；不冒充完成整条客户发布。原UI P1、server continue、live私有候选/新照片/审阅回执/DataIssues、真实provider/P95和三时钟20件验收继续，fullDeliveryReady=false。
