# P2f7a：服务器受控图片目标

当前浏览器直传凭证可以在有效期内再次PUT原对象；历史检查不能据此授权ready。为后续目标保护增加backend-only catalog-sealed逻辑namespace，实际对象仍在catalog/sealed/下，兼容现有catalog交付路径。身份hash、内容SHA和每次保护attempt的随机hash均为64位小写hex，扩展名仅jpg/jpeg/png/gif/webp；路径不使用商品名、源URL或用户文件名，也不依赖月份。

公开的getUploadCredential broker拒绝reserved前缀及路径别名，且在SDK mint之前拒绝。服务器putObject通过私有metadata minter，仍复用已验证PUT/headers/raw bytes/beforeWrite合约，可以写reserved目标，不向浏览器返回写凭证。LocalDisk同一path planner可测真实checkpoint/写入/读回；不新建SDK方法、WORM/版本锁/异步复制承诺。

这只是保护目标的地址和凭证边界，尚未切换任何图片记录、复制真实图片或写ready。随后producer须持久化attempt/目标、处理丢ACK与回收、当前lease/image/source CAS切换，并在全采用集复核后封印。真正云存储权限与已签发凭证行为还需test现场检验；namespace本身不等于物理不可变。

CloudBase SDK gate已重读；Context7不可用。本次读取官方server/node-sdk/storage、storage OpenAPI和已安装3.17.2调用体，继续使用node SDK data.url/token/authorization/fileId/cosFileId及PUT headers，不能误用OpenAPI字段作为SDK返回形状。属性筛选/分类/发布状态不扩展。fullDeliveryReady=false。

本地结果：55存储组合与1实际交付小流程通过，完整media157项，Node20关键178项；广泛admin546+public131+local375=1052，0失败/跳过/取消；五后台类型及新增delivery类型、8文件Biome、SDK106通过。8实际源码故障均检出，44–55正控、0跳过/取消、3源码finally恢复。新增“缺checkpoint”2条红测修复后，CloudBase与LocalDisk都在任何SDK/文件写入前拒绝；注册callback后等其完成才写字节，callback真实落库仍由后续producer保证，不能将callback存在当作封印。

实际LocalDisk→记录→管理员鉴权预览读取准确PNG，预览只返回字节不含存储地址；public在refcount0时404、fixture增加到1时返回同字节、恢复0后404。这是本地交付gate小流程，未经过实际商品审批/发布，不冒称P7业务验收。正常broker/旧Buffer和stream路径继续通过；SDK metadata mapper从公开method移入private function，TypeScript AST打印结果与基准body完全相等，匹配现有getUploadMetadata probe行1/1。官方node/OpenAPI内容保留输出，版本3.17.2调用体/SDK返回与OpenAPI不同字段继续按各自合约使用。

实际复核path planner、broker/private minter、tracked PUT、LocalDisk、admin/public交付、shared只读存储字段和相应测试。撤回了导入排序导致原文件头评论移位的无关差异。措辞将“有检查点”改为“要求并等待beforeWrite回调；持久性由producer证明”。尚无正式consumer、目标迁移、ready写入或云资源/业务动作；进入持久保护attempt与CAS切换。fullDeliveryReady=false。
