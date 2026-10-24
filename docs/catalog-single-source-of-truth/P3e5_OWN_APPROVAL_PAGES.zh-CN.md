# P3e5 同一操作的审批分页

状态：本步局部验证通过，整体验收未完成。基线733d90b。

## 运行边界

P3e4仅能保存自己的审批游标；新版根的旧page/finish严格拒绝。本步只增加内部operation-approval-page(productId,operationId,inputDigest,page)，复用既有20配置/页的投影及不可变行引擎，原根更新nextPage。HTTP/UI、finish/公开、分类/供应商merge、source/media准备回执仍不启用。

每次读取当前admin、原根、产品和原source/observation/link；核对原输入/intent/saved/策略/TTL、版本与准备内容。page0重试不得借其他操作的行；源行 revision/hash仍须校验。新页全体输入读取和校验在任何写之前；20行和根cursor在同一事务/文件原子写，坏ACK全体回滚，重复页0写。准备和批准回执不能推定published。

将旧分页读取/投影/哈希/行构造提为无operation/staging运行时依赖的共用模块，两入口复用。旧schema、页号验证、已完成重试和错误报告保持；不将own根投影成假旧DB返回来绕过strict解码。新root保留operation/saved/createdAt，旧page/finish继续拒绝它。

最坏native页预算：actor/root/product3读+来源3读+20源配置读+20不可变配置写+根1写=47文档操作，低于原98应用预算；无actor/sharedregistry/image写，无写后读。最终大媒体协议预算尚未解决。

读回component预算应保留初始512KiB负载，而cursor从0变499会多2字节；不能因自身游标增长误拒旧合法负载。需要有界元数据证明/codec边界测试，不能提高业务属性或正文上限。总体根1MiB预算仍严格检查。

验收：21配置两页串联/get/start/保存重试/丢响应、105配置多页、未来页/错ID/权限/过期/版本/来源/源行hash拒绝，旧分页回归、原公开版本不变；native真实保存串联/所有读取先于写和first/last/root坏ACK回滚；4进程重开；源码反例；全本地/Node20/SDK/构建。所有fixture恢复，真实云/test和20商品发布未完成。

## 实施与验证

新增catalog-approval-page共享模块，旧入口的读取/验证/页hash与不可变行字段及顺序经格式归一化后与733d90b一致；页号条件180组边界向量等价。既有CatalogValidationError/Zod报告保留。共用准备函数只读，全部成功后共用写函数写行与根，拒绝假旧job解码。own入口每页复用currentApprovalOperation，get/start/重复save和重复page保持原操作/保存回执/TTL；所有读取先于写。批准/发布没有在本步发生。

ApprovalFailure类型移入无运行时循环的job合约，并从原staging出口显式重导出，修正TS2742类型可移植问题；响应错误枚举是既有审批错误，未新增第三方SDK调用或类型shim。整个native adapter源码与733d90b逐字一致，原actor fence不变。

fitsApprovalJobBudget只将有界nextPage/state换回初始表示后核对512KiB负载，整体根仍严格1MiB。有效schema的codec边界样本在0游标恰为512KiB，游标10变大后仍读得回；正文再加1字节拒绝。该样本只验证codec预算，没有把修改后的候选持久化或冒称它经过服务器语义准备；真实UTF8大正文流程在P3e4另有证明。

先红：21/105配置的两个新流程在缺少operation-approval-page时失败。最终新增41条，563聚焦：21两页、105六页、错页/输入/actor/过期/来源/版本、外来/缺失/下架配置、重复页发生变更、metadata-only变化、旧批准草稿保留、空页/未开始拒绝、native9坏ACK及JSON重开。20来源绑定隔离商品、4调用方串联起点→两页→重开→重复，420私有不可变行、20独立根/revision，published0、分类原样；allSettled后才清理。没有冒称正式UI或真实选品发布。

17源码反例检出123个重叠失败：路由关闭、未来页、重复写、hash/revision缺失、根元数据丢失、canonical ID/revision/position错误、漏行、错游标、context/etag/TTL/input绕过、预算错误及legacy strict放宽。3生产文件finally恢复核SHA。最后测试类型修正后完整矩阵重跑仍123失败，未弱化断言。

Node20实际installedSDK仅替换HTTP：12组、来源绑定页47文档操作、真实startTransaction延迟时冻结page、21行canonical hash/位置、零重放写；first/last/root×silent/coded/wrong-upsert共9坏ACK全部回滚20行及游标，清故障后重试成功。来源变化后旧页重试拒绝。4个独立Node24/20进程丢弃页0答案后重开/续页1/重复零写，原根/revision不变且fixture移除；不是云MVCC证明。

七包+scripts4825：shared309/DB1543/admin637/local616/public131/sync304/site797/scripts488，0fail/skip/cancel。Node20相关713、19包types/E2Etypes/Astro216项0error/0warning（8既有hint）、8文件显式Biome/SDK/diff通过。最终全量types发现batch测试Record<string,...>无法保证键存在，改为有限键联合，无断言或!绕过；esbuild证明修改前后测试JS相同，相关5测试在Node24/20、全部types及17变异矩阵重跑。全量包测试没有产品失败。错误precommit --silent PASS不作证。

实际审阅8个实现/测试文件和本MIU、IMPLEMENTATION_LOG、SDK-PROBE，另外核对旧HTTP工作流/公开不可变读取与native写入约束。措辞从“审批完成”改成“配置页已暂存”，以state=staging、无新approvalReceipt、published=false及旧批准版本不变断言核对。所有私有页尚不能证明最终批准、最终公开或媒体计数完成。

后续：own finish/批准回执、最终visibility、冻结分类/供应商上下文、source/media准备回执、create/live、合法大媒体协议、physical hold取消、状态DTO和UI、历史审计、云race/P95、test部署、3时钟resync及真实20件发布/readback/仅own manifest回退。原正式发布响应丢失E2E仍P1，fullDeliveryReady=false。精确SHA产物在提交审查后补证。
