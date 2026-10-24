# P3e3：发布意图的草稿阶段

基线1feb275。内部publish操作现在能先保存自己冻结的草稿和saved回执，不批准、不上线；原HTTP/UI仍未接入。精确提交产物验证在审查侧车补录。原正式发布丢响应P1保留，fullDeliveryReady=false。没有test部署、客户数据或真实选品写入。

本阶段允许未发布/未归档商品的save-draft或publish意图使用同一个保存引擎；live/refresh-live、create、下架/归档意图及新增媒体仍不走这一阶段。此前“publish不能执行草稿阶段”的范围限制被明确扩展：保留live/withdraw/archive拒绝断言，新增publish保存成功且仍未发布、未批准的断言。这是新增内部能力，基线SDK对照的stale不能当作新发现的生产缺陷。

查询和写入按实际intent检查冻结的产品/原行revision、输入补丁/actor/年龄/策略、已批准身份，以及Alibaba来源/observation/link摘要。将产品标量快照提为纯productSnapshot；进入写阶段前已确认原source绑定仍匹配，生成saved回执复用该绑定，重新计算自身保存后的网站/内容/生命周期/分类/批准身份。回执生成不再做存储IO，避免写完商品/别名后再读取来源。初始base不变，重复saved零写，无新全局或actor写，原分类actor fence逐字节保留。

保留不存在的published/archived/主分类/子分类字段，不为了发布意图强补分类；实际上线资格由后续阶段处理。无变化保存只推进一次取消旧意图的生命周期，保留sourceReady/内容代数；来源实际变化会使原操作过期于当前输入，需要新操作，不能借重试刷新原guard。仅lastSeenAt、updatedAt和observation观察时间的采集变化仍可继续。新配置图片返回具体字段，文本不部分保存。

先红：两种JSON手工/来源商品及native来源商品对照不能进入新增阶段。最终400相关用例通过，另新增20/50/100自有JSON数据子流程：每轮最多20、驱动四个调用方，逐件start→save→get、自身初始/保存后source核对，重开后逐件重复零写，回执/productId唯一，错借另一operationId拒绝，分类/可见性缺省保留，所有商品仍未发布、没有批准版本。50分20/20/10，100分五轮20。该驱动不证明生产UI并发配置或完整发布，更不替代test真实20件验收。

六源码反例检出69个重叠失败断言，finally还原3生产文件核SHA：关闭新intent、写层偷用旧source代替新读、保存后丢source、回执误用保存前产品、写后再次读source、放行live阶段。写后读反例明确触发既有native事务“all reads precede writes”，未放松该断言。另删JSON自身回执写入，三个批次均红；批次驱动使用allSettled等所有调用结束后才清理，没有ENOENT造成的伪失败。69不是独立缺陷数量。

Node20编译本次native保存/staging与实际installedSDK，仅替换HTTP：10种坏ACK全体回滚/重试、6来源冲突前/后保存顺序、采集变化允许、保存后来源绑定、重复零写通过；一次正常保存16文档操作，全部读取在首个写入前。四独立Node24/20禁网进程为来源商品保存后丢弃答案、重开/重复零写，sample回执1917bytes，初始基线/source记录保留，自有fixture清理。原save-draft四进程回归同样通过。SDK探针不是adminHTTP、云端MVCC或P95。

最终七包与部署脚本4664：shared309/DB1399/admin637/local599/public131/sync304/site797+scripts488，0fail/skip/cancel；Node20相关六文件477。19项目types、Astro216零error/warning8既有hint；五完整文件Biome、忽略native函数格式/原actor块字节核对、SDK/diff通过。新测试的重复import、import排序、多声明和nullable类型错误已修正后重跑，不计业务红；没有类型断言绕过。错误precommit lint --silent输出不作证。这里的全量指这些包/脚本测试，原formal发布丢响应用例尚未转绿。

下一步同记录审批的容量模型使用实际旧prepare接受的524256字节审批job和262144字节原请求上界，组合样式787891bytes；该原请求正文超网站单字段限额，只作为保守容量上界，不是已保存的合法审批状态。模型未改变任何当前512KiB预算，也未证明云端上限/吞吐或解决合法大媒体的98操作预算。后续须继续复核同记录schema、阶段证明、分类/供应商上下文、媒体、live和最终可见性回执，才能开放HTTP/UI。

简化/措辞复核：六代码/测试路径、原保存事务/生命周期/源快照/批准及readonly状态消费者已读。一套保存计划和快照，源读取与纯保存后快照分开，避免重复IO；无新collection/SDK/shim/依赖。代码注释从“The source was checked”改成“Reuse the source binding checked before any product or alias write”，限定为本意图的绑定；记录统一称“内部草稿阶段”，不把20/50/100驱动或SDK发包控制称为客户发布成功。完整HTTP/UI、冻结分类/供应商merge、审批/最终可见性、大媒体预算、历史审计、云并发/P95及test部署/三时钟resync/真实20件发布恢复仍待完成。
