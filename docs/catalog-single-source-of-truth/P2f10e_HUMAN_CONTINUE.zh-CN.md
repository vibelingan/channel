# P2f10e：有界继续准备与实际状态恢复

catalogPreparation 增加 continue/jobId，沿用会话、当前用户、admin、detail rollout、4096字节和严格输入检查。浏览器不能设置actor、签名call、nonce、目标函数、qualifier、重试或超时。服务端先读取当前状态，仅对当前输入且推荐continue的任务申请签名调用；ready、blocked、需显式retry、取消、旧输入和有效运行租约均不调用worker。调用前校验job与签名，并按18秒软预算预留8秒调用和5秒读回；前置耗时达到5秒即返回可查询状态。

生产通过真实node-sdk3.17.2调用alibaba-catalog-sync/$LATEST，固定8000ms、零SDK重试。官方文档、安装包类型与函数实现已逐项核对，见SDK探针记录。SDK的timeout只限制socket闲置，持续收包可拖长；因此生产与本地共用总时长保护，处理晚到成功/失败并清理计时器。超时表示结果未确认，不能据此认定远端取消或已经开始。没有新增SDK方法、类型shim、依赖、异步flag或云资源。

每次尝试后重新读取持久化状态。ready必须来自现有完成receipt和媒体seal证明，SDK成功或worker ready回执都不能单独授予ready。worker回执校验job/product、错误码、计数和、诊断、attestation。仅确认partial且当前queued/preparing、媒体与seal进度仍一致时建议自动继续；来源503/retryable保留人工继续入口，不能循环重试。未知/畸形/跨任务响应建议查询，提交完成而ACK丢失可从实际ready恢复；中途撤权拒绝私有状态。日志只保留jobId、类别和受限provider code，不记录原始错误或凭据。

实际HTTP、JSON存储、图片导入与像素检查组合覆盖普通partial到ready、伪造SDK ready、已完成丢ACK、调用超时后原任务完成、并发编辑/取消/撤权、来源503后同任务继续。未分类商品可以准备内容，但保持未发布，当前规范发布校验仍因缺主分类拒绝。最初新增测试误期待内容报告含分类warning，核对批准方案与检查器后改正测试预期；没有修改分类或注入不属于内容检查的warning。

18个实际源码反例全部被断言检出，通常保留45–74个正控/75项，移除总时长保护的专用反例保留3正控/5项。原字节事先落盘备份，结束校验恢复哈希。完整DB1156/admin637/alibaba304/local486，共2583项零失败、跳过、取消；Node20七个实际测试文件279项通过。首次Node20命令含一个不存在的文件名，没有执行成功；更正后结果单独保留。三个直接消费者类型、14完整文件显式Biome、SDK新增块格式与完整语法、SDK gate和diff检查通过。pre-commit的--silent错误不算检查证据。

本地与云函数入口使用同一个带来源导入的worker runner，本地超时后长驻任务可能继续，测试会等待其收尾再清理临时目录。worker有界处理与持久化检查保持原契约。精确三函数产物和实际bundled admin→SDK传输→bundled sync串联在审查sidecar追加，尚无部署或真实商品发布操作。

这一步没有承诺20秒内远端一定完成：外部/数据库延迟仍可能使调用结果不明，后续UI必须按真实状态提供查询、继续、取消。列表准入、问题与草稿编辑fallback、稳定发布意图和大媒体暂存、历史修复、完整组合/性能和test真实20件发布恢复仍待完成，fullDeliveryReady=false。完成ready的媒体保护也须在P4提供可行的编辑/解绑后保存入口，不能提示用户取消一个已完成且不可取消的任务。

文案实际核对continue/invoker、API与handler/index、共用runner、本地配置、SDK探针及组合测试。将“调用成功”改为“结果确认或读取当前状态”，将“取消超时任务”限定为“超时结果不明”；对照测试中的调用次数、当前ready证明、分类/未发布字段、日志脱敏和实际计数。
