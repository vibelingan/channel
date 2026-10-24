# P2f10d：后台人工准备控制入口

现有 admin POST 增加 catalogPreparation，继续经过有效JWT、当前用户行、admin角色和 detail rollout 检查；没有配置服务端 authority 时拒绝。严格白名单只接受 start/productId、status/jobId、cancel或retry/jobId/expectedLeaseVersion，actorId由已重新验证的会话绑定。请求体上限4096字节。dispatch、claim、租约、任意actor及技术提交命令均不开放；返回只投影安全progress/status，异常技术结果不会把签名或grant带到浏览器。

生产与local-server沿用已有JWT secret，以显式环境创建服务端authority；纯本地采用具名local-catalog-preparation环境。capabilities仍只返回既有enabled，没有泄露authority或把准备执行宣称为已完成。现有generic CRUD对adminAccess:none的拒绝仍经过完整handler回归。本单元不调用云端worker、不修改云配置、不接UI，也没有自动给商品分类或发布。

启动或只读查询的响应无法确认时，用同一人工命令再确认一次；同输入启动复用同一job。取消或重试的响应无法确认时，只查询当前状态，附 recovery=status，不能重复重置写入。这个标记表示查到了实际状态，不代表取消/重试一定成功。测试包含取消请求未到达、原任务仍queued的情况，不能显示“已取消”。两次启动确认都不可用时停止确认，保留可重查同一任务；恢复期间撤权仍拒绝私有进度。服务端仅记录动作和受限商品/任务ID，不记录签名、secret或来源原文。

实际小流程经过HTTP适配器、session handler和JSON持久化：启动→真实像素worker部分完成→查询不改盘→取消→重试→多步ready→编辑后旧状态失效、新启动产生新ID，分类/未发布状态保持。另对新商品在实际建job提交后丢ACK，服务器可确认同一job；取消和重试各自提交后丢ACK也只查一次状态，实际写命令不重复。

初始两项红测先暴露入口缺失；之后业务复核将“启动丢ACK给500，用户手动重复”改为服务端有界确认，三个真实持久化红测先失败再修正。类型检查发现夹具用了不在项目Role中的user和未收窄的可选users数组，已改为真实member/contributor并收窄记录。初次handler lint发现新增import排序，按两条实际导入修正；六个完整文件显式Biome最终通过。失败记录保留，不以pre-commit的错误--silent结果算通过。

十个实际源码反例分别破坏角色、rollout、请求大小、strict输入、actor绑定、技术白名单、输出投影、未知写入只读恢复、幂等确认及恢复标记，全部检出，32项中22–31个正控保留；恢复原字节后运行完整回归。DB1156/admin574/alibaba304/local476，共2510项通过，零失败/跳过/取消；Node20六文件429项、三项直接消费者types、六完整文件显式Biome、SDK gate和diff检查通过。精确产物HTTP验证随后在审查sidecar追加。

只读云端复核：管理登录READY，原目标环境三函数仍为Event/Nodejs20.19；admin为256MiB/20s，sync为512MiB/900s。现有20s admin不能直接等待可能接近20s的准备步骤后再查询结果。官方node-sdk文档和已安装3.17.2源码确认callFunction(name,data,opts.timeout)及result/requestId，但SDK返回错误码分支、未知调用结果、超时和有界续接仍需下一单元接线并实际验收。没有增加SDK方法、shim、依赖或资源。

后续UI必须按实际状态判断操作结果，识别recovery=status，不能仅凭HTTP200显示取消/重试成功；仍需提供再次查询/取消的入口。worker调用、列表准入/UI、合法大事务、历史修复、组合与性能测试、test真实20件发布恢复继续，fullDeliveryReady=false。

文案核对handler/index/API模块、local-server配置、API测试和JSON worker流程；将“取消成功”改为“恢复查询的实际状态”，将“后台完整可用”限定为“人工控制HTTP入口已接通”。真实角色、未知结果次数、任务唯一性、未发布/分类字段、测试计数均对照断言和日志。
