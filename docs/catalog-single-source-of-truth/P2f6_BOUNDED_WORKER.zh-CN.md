# P2f6：有界存储图片检查worker

在原alibaba-catalog-sync Event入口增加签名技术消息分支，先于旧timer识别。消息严格核对环境、用途MAC、30秒准入、数据库nonce和当前租约；不接浏览器ready/role/productId/图片清单。原timer和scheduler开关保持。复用现有JWT_SECRET作为独立用途HMAC的服务secret，不新增环境变量。

worker从租约取得产品、重新读取完整source/manual候选和全部采用imageIds，跳过旧的全量metadata循环（仅私有候选可选择defer；人类inspection保持原路径）。绑定policy/input/generation/完整有序imageIds的digest。默认一步最多4图、串行默认存储字节+原生像素检查，20秒软预算预留8秒完成一次检查和持久写回。图片观察与cursor在现有事务提交。结束或故障都尝试释放；释放结果不明不能假报成功。

返回unsealed-worker-step与checked/partial/blocked/retryable，仅是准备进度。所有图片被扫描仍不能当ready；来源未绑定照片和结构错误继续留下问题，后续可信producer须实际补媒体、保护物理目标并封印当前完整采用集合。未开启后台scheduler时不声称浏览器关闭后会自动继续；受保护resume是现有获批fallback。

测试先覆盖真实默认文件存储和原生像素的9图片跨3步/数据库重开、105配置完整计划但每步仅4图、签名/extra timer/过期拒绝且0DB、检查途中取消/编辑、丢ACK后从已提交cursor恢复、坏图片计入invalid、时间预算停止、release失败、不强加分类/发布写入。再连接实际functionmain，检查依赖bundle和平台native包；Mac的native artifact profile与Linux部署profile分别验证，不能用Mac启动替代Linux原生证明。fullDeliveryReady=false。

当前本地证据：worker19项（含真实main、105源配置、坏像素且SHA准确、默认重试恢复），与候选/观察/真实文件租约组合120及Node20同120通过。10实际源码故障在此前118组合上全部检出，114–117正控、0跳过/取消、3源码finally恢复；后来只新增2个测试，不重记故障轮数。最初38组合相对路径再次漏了admin文件，改成root Node明确列文件重跑；defer沿用既有incomplete状态，测试错误的pending期待已修正。exactOptionalPropertyTypes通过有值才传option修复，不开放human defer。

红测发现并修复领取数据库异常直抛，以及最后图片检查中source photo binding变化仍回报旧采用集合checked。后者在扫描末尾重新读取完整候选、比对计划digest，仍只提供历史unsealed状态；途中及最后release前取消/产品编辑继续拒绝。原始alias与当前image记录未来仍可变化，最终封印/物理保护尚未完成。

广泛admin546+alibaba303+local374=1223、四types、SDK106、显式9文件Biome通过。新workspace依赖只增加fn-alibaba→fn-admin与相对link:../admin；普通offline install因元数据缓存缺失失败，固定现有lock版本只补workspace importer后frozen/offline/ignore-scripts安装验证通过，783策略条目，0第三方升级。生产package默认Linux/glibc-x64，sharp0.35.5/126文件完整性核对；另建output内Mac profile、JS逐函数SHA相等，Node20裸产物/原生四格式smoke通过。旧wip release不算已提交SHA；提交后须重新构建并验health。这里只证源码真实main和各产物/解码组件，未取得云数据库执行整个已打包worker的证据。

实际文字复核worker、private defer/human隔离、正式main分支、workspace/tsup/lock、默认字节像素模块和上述测试。将“扫描结束”与“可以发布”分开，将“单步预算”改为“软预算”，保留数据库/codec不可硬抢占的边界。无新timer/资源/SDK方法/shim、发布/分类/云业务写入。后续source媒体补全、保护/封印、native列表、统一操作/UI、历史修复及test真实单件/20件恢复仍必做；fullDeliveryReady=false。
