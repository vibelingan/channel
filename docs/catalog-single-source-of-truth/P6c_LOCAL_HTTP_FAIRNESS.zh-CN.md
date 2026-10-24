# P6c：本地数据库队列与 HTTP 响应

P6b 的 canonical r5 有 14 件实际完成发布，却只确认 13 件。原 trace 中一件首个状态读耗时 6507.7ms，匿名详情成功，最后状态读未在 8 秒预算内完成。不能删除最后确认或把已发布行数直接当成功。

使用失败时的完整隔离数据库副本重放现有客户端协议：仅确认的 42 次读取全部成功，最慢约 0.54 秒；同时推进新的 20 件发布时，r4/r5/r6 均只有 19 件确认，整批约 48 至 52 秒。r6 额外保留原始 transport 错误，实际为 ECONNRESET，涉及一个状态读和一个 continue；与浏览器预算耗尽分开记录，不能把所有异常都叫超时。原始结果和 CPU profile 在 p3e1/readback-replay-*、readback-cpu-*。

CPU 采样主要落在本地单文件的同步 readFile、JSON parse、structuredClone 和持久化。原 withMutationLock 只 await 已解决的 Promise；连续阶段可以一直在微任务里处理，HTTP socket 和 timer 得不到执行机会。新红测启动真实 HTTP 服务，在连续 100 次实际数据库读取中发请求；旧实现直到全部读完才响应，断言失败。这个小测试证明响应调度问题，不把普通 localhost 延迟换成随意的毫秒阈值。

修正只有 import 和 5 行：取得原 FIFO 位置并读取最新文件快照后、执行事务前，await Node 的 setImmediate。随后仍在原锁中执行整个事务和同目录原子 rename；不在事务中间让其他写入进入，不缓存文件或商品，不改字段/版本/分类/计数/云端 adapter/SDK。异常仍在 finally 释放原队列位置。

第一次聚焦回归 23/23，包括真实 HTTP、重新打开只读、重复 start、不改文件、两个 adapter 的竞争与已有商品规则。让出位置最初在 load 前的重放 r7 为 20/20 确认，零 transport failure，整批 53.7 秒；原始私有副本和进程清理。它不是云端 warm P95 证据。

四类商品 taxonomy 的定向重跑 r1 没进入发布：复用失败后 r5 快照，里面已经有此前创建的同名子分类，因此被 Duplicate child name 正确拒绝。保留失败，改用 taxonomy 尚未运行的 r4 快照重放；不修改真实分类、不放宽唯一性、不改测试断言。r1 属于重放准备失败，不能算发布回归。最终 load 后位置的定向 r2 使用正式 Astro 构建、原 taxonomy 测试和完整 r4 数据副本，四类各 14 件全部发布确认；分类变更、下架和 storefront 检查通过，1/1（3.1 分钟），零重试。退出时自建媒体/DB 与同磁盘构建目录删除，原 Playwright 9 文件哈希相同恢复。完整 canonical 组合门槛仍开放。

扩大 Node20 原始源码回归初次为 1080 过、6 失败、零跳过，未记通过。三条 rename 故障注入因新增调度点早于文件读取，变成 EISDIR/read；把让出执行机会的位置移到读取快照后，既保持原事务边界，也保留原测试钉住最终 rename 的断言，没有改这些故障测试。另有一条子进程继承相对 TSX_TSCONFIG_PATH，换 cwd 后路径错误，执行命令改传绝对路径；另两个本地导入流程在加载 Admin 的 catalog-import-media 时导入 undici 8，在 Node20 下不支持 markAsUncloneable。继续沿入口和现有 bundle 复核：该模块虽然位于 Admin 包并被导出，但当前消费者是本地导入 CLI、预览 seed 和测试；云函数 index→handler 没有导入，现有 bundle 中 undici 出现次数为 0。因此已证实本地导入工具的 Node20 兼容失败，尚无线上批量发布受该依赖影响的证据。下一单元修复依赖并验证真实媒体抓取、导入和 Node20 制品，当前不部署。随后 Node20 的 HTTP、原故障注入与 mapping 子进程 28/28；完整 62 文件改用项目 Node24 执行，最终 1139/1139、零跳过（readback-fairness-local-node24-all-r2.log）；最终 load 后位置的实际 UI 重放也通过，详见前段。

实际复核 json-adapter.ts 的锁、load/persist、native 审批事务与 get；新 HTTP 测试、原 reservation/identity 竞争测试和原客户端 check。将“发布失败”限定为“发布已完成、确认读取失败”，核对 ECONNRESET 与浏览器 8 秒截止是两份观测，事务边界和云端实现没有变化。旧 JSON80 原始失败的返回码仍缺失，不能因这次调度修正就声称它已归因。历史审计/启用、最终制品与 test 三件时钟/20 件/COS/性能未完成，fullDeliveryReady=false。
