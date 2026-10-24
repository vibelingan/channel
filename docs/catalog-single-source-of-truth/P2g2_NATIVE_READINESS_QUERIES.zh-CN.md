# P2g2：原生准备范围与可确认的列表结果

后台列表新增可选 catalogReadiness：normal、issues、preparing、unchecked。normal保留published字面true的行和当前ready草稿；issues为当前blocked的未发布行；preparing为当前checking请求或preparing检查点的未发布行；其余未发布记录归unchecked。分类仍是独立AND范围，无分类的ready草稿可以进入Needs classification，不强补分类。新来源阻断不能让已有公开商品从目录消失。

本单元使用现有受管state/policy/report/request，不新增一套存储投影，不逐行读取来源、SKU、任务或图片。摘要条件核对策略、schema、商品身份、当前代次、状态、可用标志及ready媒体seal策略。原生expr里的标量比较防止Mongo普通eq/in把数组当成员匹配；缺失/空代次按既有契约视为0，坏类型、负数、小数与不安全整数不能取得ready。数值操作由动态cond保护，坏记录不让整页查询抛错。

这些条件查询可信写入层已经验证的摘要，不重写完整内容或report的Zod规则，也不授予发布权限。直接篡改数据库、历史损坏完整report/批准内容仍须由P5审计修复；不能把这里的轻量查询说成全文校验。旧数据缺字段归unchecked，默认目录仍沿现有行为。UI入口和历史核验完成前不切换默认严格准入。显式恢复范围绕过旧hidePreparing，等待来源照片的商品仍可在unchecked中查到。

CloudBase使用同一个where基线先count，再sort/skip/limit/get；JSON在total/slice之前筛选。原生列表主体提取为listDocumentsInCloudBase，生产适配器直接调用，契约测试也调用同一实现。新范围保留原排序优先级，末尾补唯一_id次序，避免旧记录相同/缺失时间戳按不稳定顺序跨页。已有_id排序不重复追加，未指定新范围时排序行为不变。count/page采用同条件，不构成跨两个请求的数据库快照；并发变更仍须由后续UI冻结实际ID和刷新规则处理。

审查发现旧列表把缺失total当0，并可能接受错误码、非整数计数或无身份行。红测22项中13正控/9失败，随后使用原sdkAnswer保留错误码并验证非负安全整数total、行数组及非空字符串_id。不确定读回明确失败，不伪装成功空列表；合法空目录仍可成功。已检查database1.4.3的get/count实际返回：code失败原样返回，成功分别data和total。没有根据无关OpenAPI或PG例子猜返回形状。

初次范围红测7项全部是断言失败。实现后数组published的blocked夹具最初被误写成unchecked预期；独立推导后明确它不是字面published，且当前blocked，应该在issues，保持normal中不能误认它为公开的断言。类型检查检出optional参数从rest传播undefined，改为显式解构并条件加入。测试直接调用原ESM云初始化遇到CJS命名空间互操作差异，改为提取生产实际调用的列表主体，未篡改SDK或声称此测试证明云初始化；精确部署产物另验。stdin探针的wx变量名冲突、functions V8缺structuredClone及Biome stdin需write标志都留日志，不算产品红测或通过。

实际安装wx4.0.2和node3.17.2共同使用database1.4.3；源码/类型及实际serializer证明and/or支持数组与varargs，expr可携带嵌套原生表达式。SDK门禁新增两套serializer与纯对象输入逐树对比。aggregate.type方法在安装包中不存在，本实现没有调用或声明该方法，而是用已有expr传递$type原生表达式。只读云端查询证实当前数据库支持该表达式、ifNull、数值/标量和条件保护。官方参考：[NoSQL查询](https://docs.cloudbase.net/api-reference/server/node-sdk/database/fetch)、[操作符](https://docs.cloudbase.net/en/api-reference/server/node-sdk/database/command)、[ifNull](https://docs.cloudbase.net/api-reference/server/node-sdk/database/aggregate/operators/ifNull)。Context7不可用。没有添加SDK类型shim、依赖或云资源。

独立云端证据：T142指定ID只读基线存在，四个实际SDK序列化范围只有unchecked匹配，不能说它已修复。将31条合成边界记录放在只读表达式变量中，对四范围共124个真假比较全部匹配；每范围反转一个预期后均返回0，排除空测。合成记录没有写入数据库，结果只返回现有商品ID。第一版常量bad-string的mod反控在查询优化期就报错，不算动态保护通过；改用行变量后保护通过，再完成124组合。此证据验证数据库表达式语义，不是部署后浏览器或吞吐验收。

边界覆盖旧字段缺失、null、旧policy/schema、身份/代次变化、数组状态/策略/标志/published、错误seal策略、错误checking身份代次及旧代次0。四范围逐页取满、总数/重复ID/重开一致；分类、子分类、搜索和OR条件在范围内AND组合。合法空结果和三种排序的唯一_id尾排序有正控。实际原生PNG/磁盘/JSON worker走checking→ready→编辑失效→blocked→修复→ready，分别验证有分类和无分类，始终未发布、未强加分类。

13源码反例覆盖身份、代次、标量策略、媒体策略、公开行保留、unchecked互斥、原生/JSON分页前筛选、facade传递、恢复入口、计数和身份读回及稳定排序。前12最终每次31项保留24–30正控，排序35项32正控/3失败；均是断言检出。首轮第7项夹具错误地不能模拟无where查询而报TypeError，主动停止并恢复，不计有效检出；修正夹具后完整12项重跑。finally备份恢复、SHA逐项核对；之后只作等价格式和新增排序行为，排序独立反例再次验证。

最终恢复后全量DB1200、shared305、admin637、local499、public131、sync304、site691，共3767项；Node20三个组合文件133项；全部零失败/跳过/取消。六后端消费者类型与Astro213文件通过，Astro零错误/警告、8既有hint；13个完整非忽略文件Biome通过。项目忽略cloudbase-adapter，另将整个新列表主体交给Biome检查并比较返回文本，等价通过，未改项目排除规则；diff检查通过。Biome早期stdin错误不计通过。精确SHA三函数/站点构建和产物串联另记review侧车。

逐一审查14个代码/配置文件、原查询语义、SDK get/count/where/orderBy实现和worker写入失效接缝。文案将“正常范围”限定为列表摘要范围，保留完整验证与公开版本的独立权威，明确124比较使用查询内合成数据且无写入。核对31/35/133/3767、恢复哈希、分类和发布状态，未把只读云查询冒称真实20件验收。

后续接现有列表UI、状态范围/分类计数/选择重置、请求代次与失败重试；P5仍需完整旧数据审计、索引/性能核对和有界修复后才启用默认严格准入。稳定操作、大媒体、认证过期草稿与占用恢复、全组合性能、test真实20件发布恢复仍继续，fullDeliveryReady=false。没有新分支/worktree/PR/push、部署或真实商品写入。
