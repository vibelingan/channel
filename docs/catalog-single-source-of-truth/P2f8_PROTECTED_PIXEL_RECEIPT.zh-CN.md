# P2f8：受控图片的版本化像素回执复用

按整合方案中“新增缓存必须有版本条件”的要求，减少不同商品重复下载和解码同一张已受控图片。复用私有catalogImageObservations，不新增资源。像素策略单独版本化；网站属性规则变化不要求重拷图片。

仅接受当前active图片、无互斥锁、当前目标摘要、完整私有committed保护登记和相同image/attempt/intent。全局回执键绑定pixel policy/imageId/目标摘要。回执只允许verified健康字段，旧策略、损坏、字段不匹配或未保护目标均为miss，回到默认真实读取。它不授予商品ready或发布权。

写入复用现有put-image-check/advance-media-check事务：先完成保护登记和现有回执读取，再原子写技术job/当前观察/需要更新的全局回执；同一已存在回执不重复写，避免共享图片产生额外热写竞争。新getter仍要求当前服务lease和当前商品输入，随后worker沿现有观察/cursor提交再校验。默认图片producer只有begin返回committed才尝试复用；首次复制照旧完整读回。

边界：依赖受控命名空间只能由服务器登记流程写相同校验内容，不能把历史原始地址观察用作缓存。CloudBase权限及正式Linux云worker现场门槛仍保留；缓存不把外部存储管理者的手工破坏变成安全操作。实际性能仍需冷/热批量测量。

先写测试：共享商品只复制/解码首次、旧策略真实重查、未保护不复用、错图/目标/锁/登记/健康失败不复用、当前lease/输入失效拒绝、回执同事务失败回滚、同健康不重复写，以及默认worker跨商品实际零对象读取复用。


已实现：当前private getter、版本化verified回执、既有观察/cursor事务中的按需写入及默认producer复用。共享商品的实际文件测试确认第二件零对象读取/零PUT、全局回执不改写；旧策略只读同一受控对象一次，不再复制。缓存异常返回miss，单次缓存读取运输异常退回实际默认health；正式观察提交仍复核当前任务/输入。getter结果为读取时的快照，不独立授予ready；取消/编辑的最终竞争由观察/cursor事务处理。

review新增修复两项：缓存读异常原先误触begin确认恢复并成为不必要retry，现保留实际读图fallback；新增服务器保护标记/尝试ID原先随普通images get/list/update响应返回，现从响应剔除。原严格CRUD写schema已经拒绝伪造这些字段，保持该保护；普通图片名字编辑保留服务器marker。管理员和贡献者读响应、普通更新各自验证，两个红测复现的是返回字段泄漏，不能冒称既有写保护坏了。

证据：176组合、47图片协议与缓存、89Cloudwrapper、23默认worker及17实际producer；11个缓存源码故障均检出，正控158–175/176，3源码恢复；另一个响应剔除故障在226handler测试中被检测并恢复。类型4消费者通过。Node20原358及补完整handler后的584全部通过，0跳过/取消；新字段剔除前的扩大DB909/admin546/public131/alibaba303/local402=2291通过，最终admin套件548另行跑完后以实际日志附记。

实际审阅新cache模块、jobs读/写分支、producer fallback和目标摘要保护、DB/Cloudwrapper/local/native测试、handler响应/严格写schema及两新测试。文字将“缓存读取就是当前许可”改为“受控目标的像素证据快照，最终提交仍校验”；SDK探针由嵌套文本匹配修为精确callee，保存真实签名和失败记录。无商品/分类/发布/approved内容变更，fullDeliveryReady=false。
