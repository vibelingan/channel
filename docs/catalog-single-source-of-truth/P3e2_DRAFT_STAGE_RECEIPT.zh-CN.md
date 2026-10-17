# P3e2：草稿保存与自身回执同事务

基线b43fa82，沿原分支与目录继续。内部草稿小流程已经实现并通过针对性验证；最终全量已完成；精确提交与产物检查在审查侧车补录。未开放新HTTP/UI，原发布丢响应P1未关闭，fullDeliveryReady=false。

沿原saveCatalogProductWithIdentities、native transaction与JSON文件锁，追加server-only expectedOperation（actor/UUID/inputDigest）。首次storage await或等待锁之前复制全部补丁和绑定。在同一原子边界检查actor、原请求revision/digest/补丁、当前策略/年龄/内容与来源关联身份，再运行原保存计划、分类/建议fence、slug/SKU唯一性、产品与身份写入，最后保存自身saved回执。任一写点未确认或持久化失败，整笔回滚。

| 存储状态 | 查询 | 本单元写入行为 |
| --- | --- | --- |
| reserved | 初始operation.base与冻结输入保持 | 当前内容、行版本、策略、年龄均有效，且为未发布草稿、没有新媒体引用时，同事务转saved |
| saved | 保留初始base；另存saved.snapshot/productUpdatedAt | 同输入重试仅读回，产品/身份/回执零写 |
| 旧策略、过期、他人修改/下架/重新关联 | 保留历史record并返回各保护状态 | 拒绝旧操作覆盖，不拿另一次操作结果冒充自己的 |
| 原staging/complete审批 | 沿原合约 | saved/reserved不能被旧finish消费，没有批准或发布效果 |

current表示有意义内容、来源关联和策略仍一致；revisionCurrent单独表示原行revision仍匹配，expired独立表示年龄超限。恢复必须三个保护同时通过，且写入层重新检查。仅采集时间变化不会变成网站内容；如果它推进了产品updatedAt，原revision不再有效。这保留旧capture-only测试，不用改变内容语义来掩盖CAS差异。自身保存用已存productUpdatedAt作为后续行保护，同时仍要求调用方携带原始请求guard。

record只保留网站补丁、摘要和计数，不复制完整供应商来源。请求输入256KiB、内部捕获/record512KiB、有意义快照2MiB为应用预算，不是平台容量承诺。准备/媒体/像素策略按有界字符串存储，旧策略可读但不能继续；草稿来源身份由产品标量摘要冻结，不为修复坏来源额外读取供应商全文。没有绑定的旧调用没有额外存储IO；本地样本保存≤13文档操作、回执1218bytes，不能代替云端容量或P95。

name/description修改使用现有网站合约。description按实际审批投影先trim用于检查，空值对应省略展示字段；存储保留编辑框原文。有效清空、空白、首尾空白、30000字符及带空白的上限文本均可保存并经实际planCatalogDetailApproval确认。超限返回invalid-product与具体字段，避免让用户反复刷新。未修改的坏来源/标题可逐项修复，不静默截断。三类照片字段均检查新增引用；保持/排序/移除已有引用可保存，新增引用留给后续媒体阶段且不先写文本。未分类商品保持缺失主类/子类，不强补分类。

测试先红：最初27项8正控/19失败；配置照片隐藏新引用与live误用33正控/2失败；字段反馈2JSON+2native红；正常空/空白描述4红；metadata-only查询/写入保护不一致2红。修改代码过程中类型推断/显式undefined与夹具共用对象错误均留档，不当业务证据。首次强行把时间戳变化算内容变化使旧capture-only测试失败，随后保留该断言并加入独立revisionCurrent。删除一项重复undefined判断仍绿，复核原revision严格比较已覆盖它，删除冗余而不伪造反例失败。

最终小组合374通过，包含14种native写点故障、身份冲突、权限撤销、输入等待期间被调用方修改、两种外部保存顺序、双实例同操作重试、真实JSON rename失败、重开、legacy字段缺省、旧finish隔离及旧写入器未推进版本的内容变化。27项源码反例全检出178个重叠失败断言，3源文件finally还原核SHA；不是178个独立缺陷。

实际compiled native保存/审批原语和installed SDK仅替换HTTP，Node20完成10种写回执故障的全体回滚/重试、两类字段错误、6种正常描述与重复零写；未把它称后台HTTP或云端验收。native另注入事务已提交后丢答复，调用失败后get仍返回自身saved，重试零写。四个独立Node24/20进程在禁网自有JSON库保存后丢弃答案，重开确认同一saved回执并重复零写，fixture清理。Node20完整小组合374通过。最终七包与脚本共4613通过：shared309、DB1370、site797、admin637、local577、public131、sync304，加脚本488，全部0fail/skip/cancel。新增提交答复丢失单测后重跑完整DB1370、相关types及Node20小组合374，其余最终生产源码未变。全部19项目types、Astro216零error/warning8既有hint、7完整文件Biome与忽略native函数段格式/actor字节检查、standing SDK/diff通过。

接口开放前仍须完成：分类taxonomy/actor/原商品guard和supplier merge服务器计划的不可变绑定；新媒体保护与恢复；create/live/approval/final visibility的同操作回执；全部编辑、行、批量分类入口统一；原丢发布响应集成测试。本单元验证内部草稿保存；新增分类流程、发布、source重采及未知新媒体入口仍未开放。全局还需历史审计/ready启用、云端并发/P95、test部署、三件真实时钟resync及20件既有分类产品发布读回恢复。

简化与措辞复核：沿一个保存引擎和原分类actor fence（与基线逐字节相同），三个内部helper通过现有staging门面共享，DB门面只补导出返回类型解决跨包声明可移植性。8代码/测试路径及3证据文档、原HTTP/分类/来源/媒体/批准消费者已复核；将“恢复完成”限定为“草稿自身阶段已验证”，写清current、revisionCurrent和完整发布权限的区别。
