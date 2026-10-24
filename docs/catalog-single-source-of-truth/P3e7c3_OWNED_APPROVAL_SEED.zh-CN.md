# P3e7c3 保存后接入同一根的审批准备

基线e8b19ea7；该提交三函数/site与12进程（实际编译Admin start/save/replay+真实PNG）检查已通过。离线探针实际走手工商品start→save→原source prepare→同根approval-begin，确认来源共享缓存未改变原根、网站字段、updatedAt及三项generation/version，商品仍未发布；夹具已清理。这里只证明手工零配置的衔接，其余由本MIU补测。

本步增加严格scope/digest的product-operation-continue，先复用C2精确保存。save-draft意图到saved即结束；publish意图优先复用已就绪且当前generation的source candidate，否则用现有createCatalogSourcePreparer分页准备共享派生缓存，再从服务器完整读取候选/全部SKU，计算原prepareStagedApproval并附到同一操作根。浏览器不传prepared/来源页/期望digest或新patch。开始后保持相同operationId和原稿inputDigest；不走旧approve/finish另起根，不发布、不清供应商待审、不导入新照片。

数据库seed读取原根的角色/scope/digest/intent/current/revision/TTL/cancel状态，调用现有readCandidate（完整manifest、8并发点读、前后fingerprint），最后原operation-approval-begin事务再核对并写同一根，保证取消/编辑竞争可拒绝。candidate读取改为命名export复用，旧workflow行为不变；原生/JSON adapter无需修改。seed的内部大根不出HTTP，Admin只返回既有4096字节小状态。

来源prepare是既有产品共享派生缓存，不是用户发布写入；它已有来源/link/generation CAS，只改detailSource字段和来源配置投影。取消期间已经提交的缓存无需删除，但后续own seed/页面/发布仍必须拒绝；网站内容、分类、生命周期与公开权利不能改变。每页后重查原操作；来源变化、取消、撤权及时停止。缓存就绪优先路径不重做source prepare。12秒单调时钟限制新的准备工作，超出后返回当前未完成状态供同一操作继续；不能循环重做已完成来源页或另建根。已完成操作仅历史读回；staging在本MIU仅返回进度，实际页面/媒体/引用/最终发布在后续接线。

验证包括手工零配置、Alibaba 0/21/105SKU、保存修改后重新prepare仍匹配冻结输入、缓存快路径、同操作重开重复零写、错误scope/注入/取消/过期/撤权/并发编辑、source准备后取消、manual configurations显式拒绝、坏来源保留可查saved草稿与原因，以及供应商Changed/Removed不自动清审。测试先红后实现；每步review与相关测试，后续SDK/fault/full组合/精确产物。来源/媒体私有准备、live候选、供应商review receipt、完整continue/UI/真实云与P95/三时钟20件验收仍在总方案内，fullDeliveryReady=false。


实现检查发现大配置读取的继承风险：现有readCandidate逐批8点读全部manifest，极大商品可能在根初始化前耗时过长。当前补每批前后预算检查，已发出的只读请求必须完成，超限返回原saved状态且不启动begin；这不提供跨请求的已读SKU游标。C3b必须在客户producer启用前解决大候选根初始化的进展/性能（优先复用完整来源计划的服务器候选，并由后续原生配置页逐页核验实际数据），不能把重复读前几批当作可续接成功。原105SKU路径、断点、强制失效/坏缓存和最终配置页哈希的独立核对都需覆盖。整体验收仍未完成。


## 当前实现与验证

实际Admin continue已接C2保存、源缓存准备和同根seed；save-draft只保存，publish意图到staging。先尝试当前ready候选，未就绪才分页prepare，跨页仅当前request复用完整source计划；不丢SKUs、不另起旧job。DB seed只读原根与完整候选，服务器算digest/revision，最后原operation-approval-begin写同根。阶段重复/重开只读，source cache不改原根operation/saved和网站字段。stage后的配置页、媒体、引用和最终发布仍由后续MIU接入，客户UI未启用新producer。

新增35项：shared绑定7项、实际Admin+JSON28项。593相关组合、5823整包（shared334/DB2192/admin638/local884/public182/sync308/site797/scripts488）、实际Node20相关2858项通过，均无fail/skip/cancel；19workspace/E2E类型、standingSDK、八文件显式Biome/diff通过。Changed/Removed两项实际组合验证待审标记、keep摘要、原来源和零公开引用保留，未注入reviewedAt/By。来源0/21/105SKU完整prepare后冻结到同一根，完整候选点读各一次；缓存快路不重复prepare；manual configurations显式拒绝、坏来源保留saved草稿和修复issue。角色/版本/取消、来源分页预算、已发批次8读完成后停止、seed提交丢回应重开零写均覆盖。13项故障后仅追加Changed/Removed两个测试，生产SHA未变，再重跑593相关及整包/Node20；只为新增测试重查local类型和八文件Biome。两项postseed取消/编辑测试曾确实返回ok+current:false，先红后修统一状态检查；仅查询入口保留历史事实，continue不再把失效根当成可继续。一个complete分支的联合类型收窄已补，未用any/unsafe fix。

13组最终源码故障注入全部检测到：6组子集产生15次重叠失败、7组SDK-only，五个被注入生产文件恢复，另一个候选读取文件SHA保持，六文件核对一致。SDK故障各先通过518–550项此前控制再命中具体断言；包括实际Admin/index脱线、index晚捕获、误用旧approval job、错digest产生额外候选读、具体校验原因被丢弃、未知IO被猜成未就绪。其余覆盖postawait状态、来源游标跳页/错误隐藏、超时后继续source写、未传候选批次预算、共享绑定接收额外字段。守卫重叠时不声称某一个检查单独保证原子性；最终事务仍是许可。注入后SDK重建并重跑551项通过。

551安装SDK控制=原518+新33：raw与真实index seed各16项，加实际Admin warm continue一项。相同根只写一次，三个坏ACK整TX回滚，已提交seed丢commit回应保留首次revision，等待期间scope变化不串对象；原scope/digest/角色/版本和预算检查阻止不当写，候选coded/malformed读错误抛出且零写。有效101项facts保留，257项按实际256上限返回TOO_MANY/具体maxCount，错商品_id保留字段原因。最初SDK误把facts上限当100；实际100是specifications/packaging，本次未改上限。修正为真实正反例后通过，不把夹具假设当代码缺陷。

SDK测得21配置就绪候选：raw seed两笔事务6/7操作，生产facade另加6读回；两者均有21次事务外配置点读，原全套最高98/事务保留。只有HTTP替换，未证明真实vendor首读快照/写冲突、COS或P95。Context7不可用，已有官方100ops/30s、安装SDK3.17.2/database1.4.3/wx4.0.2/Zod3.25.76与standing gate核对继续使用，无新vendor方法/shim/deps/env/数据库/锁。

人工review/simplify/humanizer覆盖八代码/测试与四记录，交叉核对旧source projection/手工准备、原生根begin/保存/取消/最终publish、候选读取和共享小DTO。用真实manual探针及21/105数据独立核对“来源投影不改冻结网站字段”后才接线；把“整个候选可续接”改为“来源页可续接，整候选点读暂无跨请求游标”，保留当前大商品风险，未假称性能已达标。一次临时脚本前缀语法错误未执行源码修改，随后用保存脚本实施；不计业务反例。

提交review后执行精确三函数/site与12进程补充；编译Admin start/save/continue在同根创建seed，再接当前原生配置页/媒体/引用、满槽恢复、重开continue零写与取消结算，真实PNG字节和分类保留并清理自有夹具。该小流程不等于客户完整发布。C3b的大候选初始化进展/性能是明确发布前门槛，原UI P1、完整continue/media/live/review/DataIssues、真实provider/P95/三时钟20件验收继续，fullDeliveryReady=false。
