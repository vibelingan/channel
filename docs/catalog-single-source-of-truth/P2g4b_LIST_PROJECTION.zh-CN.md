# P2g4b：列表固定字段投影

## 本单元边界

P2g4a已在850372b独立审查、站点构建15页通过。现在先实现固定字段投影及完整记录隔离（P2g4b1）；字段内元数据/单行/整页的硬字节预算继续P2g4b2，不能把字段减少当作严格有界响应。无存储拆分、属性筛选mapping、客户数据修改或部署。

显式catalogListView=admin-product-list-v1仅支持products，旧客户端未传时保持完整协议。新响应头字段catalogListView及每行_adminProductListView必须匹配；完整get拒绝任何该标记。空页也要确认响应版本。标记只属于返回DTO，不持久化。后台优先发布，旧客户端不选投影仍可用；同SHA部署及现场健康校验在P6/P7。

CloudBase在实际get链使用固定布尔field投影；同where的count在投影前，搜索/过滤/排序在完整数据库字段上执行，无逐件来源或SKU查询。JSON同样先过滤排序计数分页，再拷贝白名单；嵌套只取autoPhotos.gallery，保留缩略图源对应关系，不传描述/SKU图片结构。新字段默认不返回。保留值和缺字段语义，不把缺published补false，不删真实存储内容。

字段核对覆盖CollectionView、ProductClassificationEditor、product-familyForDoc、review-reason、alibaba-source-review、product-pricing-editor、product-thumbnail：名称/分类/子类，原CAS时间戳/状态，SKU/型号/MOQ/标量价及手工和Alibaba价格，来源主键/状态/审核数据，review标记，gallery图源和imageIds。完整Edit/Preview继续get，行patch只用ID/版本/状态及显式字段。

## 契约证据和测试

安装wx4.0.2/node3.17.2共同database1.4.3的field声明与sender源码，官方/api-reference/server/node-sdk/database/fetch确认布尔字段投影；无Context7。两个SDK无网络实际field返回新查询，父查询projection不变，布尔编码1；不使用未证实的$slice。只读三件时钟当前完整行10085/10216/10453字节，不能把六字段样本字节当最终投影体积。现场无写入。

先用真实admin→JSON和实际浏览器/API红测确认未实现时会失败，再测原生投影调用本身而不只检查返回DTO。完整get/旧列表不变、未发布缺字段、嵌套图片保持、字段不进存储、分页/空页/省略series字段的搜索、价格及缩略图等价、摘要不能作为完整记录；异常协议有重试并禁止缓存写。后续记录执行结果和反例，不预填通过。

## 执行与复核

初始红测：实际admin→JSON 7失败，原生1正控/1失败（明确field未调用），客户端15正控/8失败，实际浏览器请求摘要1失败。省略字段搜索最初选了description，但注册表并未把description列为searchable；进入绿测前改用真实可搜且投影省略的series，避免给原有功能强加新含义。类型检查发现已知WxQuery替身缺field，补成拒绝意外投影的替身；复制历史createdAt/updatedAt保持原JSON值，使用JSON记录字典，未做强制类型转换或改值。精确optional参数须先解构catalogListView再条件转发，已修正；这些类型失败均保留日志。

显示等价12组：固定/范围/阶梯/人工/标量价格、来源fallback、来源移除、审核Changed、已发布/人工图片/来源图片、旧分类。既比对原helper结果，也要求真实非空身份、variant/offer数和适用报价，避免空结果比较得到假绿。完整get与旧列表仍含描述/series/批准内容；新摘要不含未来字段/详情结构，缺published不补false。纯函数直接修改嵌套数组验证独立副本，不能仅依赖JSON adapter下次读盘掩盖内存别名。

实际24浏览器场景与23API、12显示对照共59项通过；产品摘要被错误返回到完整GET时仍只能Retry/Close，不能打开可写表单。缺摘要版本保留重试与未知数量状态，不能显示假0或可操作缓存表。原P2g3/P2g4a检查/分类/准备/保存/晚到响应场景均通过真正服务端投影，不用手工删字段代替本实现。

10项反例全部检测：原生field移除10正控/1失败、全部字段泄漏10/1、autoPhotos详情泄漏10/1、嵌套引用共享10/1、价格主来源身份省略24/11、摘要作为完整GET55/4、缺摘要版本57/2、缺row标记33/2、主列表/分类计数不选摘要各1/1。GET/版本反例还要求实际浏览器case失败，不能只靠静态pin；各项0skip/cancel，未以编译/模块失败计红。四生产文件finally恢复且SHA核对，fault-final内保留精确备份和统计。

全量3844项通过：shared305/DB1206/admin637/local508/public131/sync304/site753，均0失败/跳过/取消。首轮site753中误用了图库环境变量，752通过/1skip，随后用实际GALLERY_BROWSER_TEST=1完整重跑753通过，未把skip算完成。Node20后端11+客户端35通过。所有packages/三函数/local类型通过；Astro216文件0error/warning、8既有hint。Biome曾指出测试delete操作，改为Reflect.deleteProperty后重跑；精确源段/全文件检查另随审查记录。

SDK探针先证实两套SDK的field返回独立查询；扩展到实际get sender后，第一次误按普通JSON比较投影，实际为EJSON的$numberInt，探针因此失败。按database1.4.3 utils.stringifyByEJSON与get源段修正预期，真实sender参数两套SDK均通过，standing gate通过。没有对产品代码添加EJSON手工处理，也没有使用未证实的$slice。

只读三件时钟按当前实际字段表计算：T142：10,216 → 2,984；T157：10,085 → 2,987；W203：10,453 → 2,999 UTF-8 JSON 字节，投影20字段含marker；价格、来源review、gallery与分类保持。统计存list-live-byte-metrics.json，属于JSON形状计算，不是实测P95或全页硬上限。仍未执行云端resync、发布或恢复。

复核实际生产文件：共享协议/类型/包exports，DB facade/adapter/原生list与固定投影模块，JSON list，admin list验证，CollectionView主表/计数/query keys，api完整/摘要读取；追踪ProductClassificationEditor、review-reason、product-pricing-editor、product-thumbnail、RecordForm及公共list消费者。角色与session重验证保留，公开调用未选摘要，无资源/权限/SDK依赖升级/存储写入。复用原生dialog及错误/Retry，无新UI样式。

写作实际修正“描述搜索”为注册表支持的“series搜索”，并将“列表已严格有界”限定成“固定字段投影”，核对10反例、59/3844/46/216和三件字节统计。P2g4b2仍需元数据、单行及整页预算；P3至P7的统一写操作、合法大媒体、过期草稿/占用、历史审计修复、云race/第二引擎/性能、真实20件发布恢复均继续，fullDeliveryReady=false。精确提交审查与构建随后记侧车。
