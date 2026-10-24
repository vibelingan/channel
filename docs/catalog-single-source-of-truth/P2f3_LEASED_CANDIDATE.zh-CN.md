# P2f3：任务租约下的候选读取

状态：实施中；fullDeliveryReady=false。此单元是实际producer的读取部分：复用已有全量来源计划和手动草稿投影，以当前私有任务租约替代后台服务的管理员账号。像素receipt、结果封印、worker入口、列表准入仍在后续，不把unsealed-inspection存为ready。

## Runtime Problem / Data Shape

现有inspectCatalogPreparation(actorId,...)前后查users，手动分支又调用readCatalogDetailPreview(actorId,...)。后台服务没有用户账号，复制admin行会把技术准备扩大为用户审批权限。把两个只读核心抽成带backend access-check的candidate reader；原人类入口保持真实admin前后校验，服务桥接只接受jobId和不透明lease，通过DB facade的renew验证当前job/输入，productId从当前任务结果取得，不接受客户端任意productId。

候选返回全量去重排序imageIds、当前product/input/gen、未封印metadata检查和结构化issues，供下一单元做真正像素验证。原admin inspection仍返回原形状，避免额外内部字段进入现有消费者。两种路径都不写产品/来源/分类/发布状态；服务桥接只续期私有job。

## Technology Constraint / Flow

新的access-check是仅后端函数参数，没有HTTP/JSON入口。失败只投影ok/code，不能透传callback额外诊断。准备租约已绑定nonce/owner/version/current input且在事务内复核；每个读取核心在开始和结束重新检查。授权撤销、输入变化、取消或接管后返回明确失败；人类失权FORBIDDEN，服务旧租约CONFLICT。无状态服务worker仍需先claim，不能凭scope JSON读取。

    current job renew -> productId -> candidate access check -> complete source/manual plan
      -> all adopted metadata -> final product/source/input + lease check -> unsealed candidate

## Risk / Test

先红测覆盖无admin用户的实际任务读取、fake/serialized/expired/cancelled租约、服务source/manual两种路径、输入读取中取消/编辑、旧HTTP人类入口仍鉴权、候选所有imageIds和原结果形状、callback私有字段失败投影。使用真实JsonFileAdapter持久任务作为服务小流程；原preview/inspection组合回归，含105/205配置和超过首屏的图片。服务metadata通过不代表像素或永久存储通过，不能据此开放正常列表或发布。

## 当前小流程证据

76项候选/原preview/原inspection/真实JsonFileAdapter任务组合通过；Node20加权限/任务状态机共183项通过，零失败/跳过/取消。真实本地服务小流程删除admin账号后仍可读取source/manual候选，产品保持原样；105张采用图片全部返回，首屏外不丢。伪造/JSON复制/过期/取消的租约在候选读取前失败；读取中取消或编辑会拒绝结果，job分别保持cancelled/stale。

精确review先发现服务桥接把adapter失败对象原样返回；新增privateTrace反例真实失败后，改为只投影ok/code。原human inspection继续不含内部imageIds；人类preview也核对返回用户_id，避免错误管理员身份。两种reader前后都用后端access-check，服务productId只取当前租约响应。11种实际源码故障全部检出，正控至少71项，3个源码文件hash恢复。

四后台类型、显式6文件Biome和CloudBase合约门禁正在与广泛回归一起读回。本单元无新vendor SDK方法/选项/shim；复用已核对的DB facade/current lease。原临时Node20归档SHA已在P2f2记录。真正像素检查、receipt、准备结果提交和Event worker尚未接线，metadata outcome=ready不等于准备ready。

实际复核两个reader、服务桥接、HTTP wrapper调用处、新旧测试及本文，将“无副作用”精确为不写业务内容、服务路径续期私有job；将“校验通过”限定为未封印候选与metadata，禁止拿这个结果直接发布。后续继续真实producer，不扩大到属性筛选或分类修改。

最终广泛回归已读回：admin535项、local-server349项，共884项，0失败/跳过/取消，2.78秒/66.92秒。四后台types、6文件Biome和CloudBase合约门禁均通过。76项小流程与183项Node20结果为同一源码；待本单元精确提交产物核对后继续producer。
