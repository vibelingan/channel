# P3e2b：新草稿保存取消旧审批

基线 ae3dd28。当前内部草稿小流程修复并回归；精确 SHA 的产物检查在审查侧车补录。fullDeliveryReady=false，原发布丢响应 P1 保留。没有 test 部署或客户数据写入。

复现：先为来源已准备、零配置的时钟启动旧审批，再保存一个新的自身草稿操作，补丁为空或描述与原值相同。原审批指纹忽略 updatedAt，内容/生命周期也没变，因此旧 finish 仍可成功。JSON 两项业务红及 Node20 旧精确源码/实际 SDK 红均保存于 output/pricing-clock-repair-2026-10-13/p3e1/own-draft-cancel-*。旧 SDK 对照使用合法 server-prepared 夹具后实际走原 reserve/finish，失败为预期 CONFLICT 却得到 complete，不是模块或构建错误。

修复沿原保存计划和事务：只有新的、已核验 expectedOperation 的 save-draft 保存才显式请求取消旧发布意图。原生命周期规则推进一次；不把 published:false 写进缺省历史字段，不改内容代数或已有来源准备结果。已保存操作的重试仍在原回执分支零写返回。无绑定旧调用保持原规则。已确认的供应商审核 no-op 不能吞掉这次明确取消意图。既有 native 分类 actor fence 与基线逐字节相同；没有额外全局、分类或 actor 写入。

5 个新增测试覆盖 JSON 空/同值补丁、native 旧审批串联、纯计划缺省兼容及审核 no-op。7 个源码反例逐一还原并核 SHA，全部检出，共26个重叠失败断言；不是26个独立缺陷。反例包括两种 adapter 忘传意图、核心不推进、旧调用默认取消、no-op 吞意图、错误失效来源、错误补写 published 字段。

还原后七包和脚本共4618项通过：shared309、DB1373、admin637、local579、public131、sync304、site797、scripts488，0fail/skip/cancel。Node20相关五文件431项通过。19项目类型检查、Astro216文件0error/0warning/8既有hint、5完整文件Biome、忽略native函数段格式与actor字节核对、standing SDK及diff检查通过。precommit错误的 lint --silent 不作为成功证据。

独立检查使用编译后的本次 native 保存/审批原语和实际安装 SDK，仅替换 HTTP：空草稿使旧审批 CONFLICT，来源 ready 保留；10种写回执故障全体回滚/重试、2种字段错误、6种正常描述、同操作零重复写均通过 Node20。四个禁网 Node24/20独立进程保存后丢弃答案，重开读自身回执并重复零写，自有夹具清理成功。这些不代表云端MVCC或后台HTTP验收。

简化及措辞复核：读完本次6个代码/测试路径、原生命周期/审批指纹/保存回执消费者及这份记录。复用原生命周期取消规则和保存引擎，未另建状态机。把“旧审批被取消”明确为“旧 finish 被拒绝”；旧暂存记录/媒体占用的回收仍属于后续完整恢复流程，未假称物理清理完成。原已批准历史保留；完整HTTP/UI、批准/可见性回执、合法大媒体组合、历史审计、性能及真实20件验收仍待完成。
