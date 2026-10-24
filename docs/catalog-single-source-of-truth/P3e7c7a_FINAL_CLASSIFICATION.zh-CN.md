# P3e7c7a 最终发布事务的分类校验

基线d67cf6ab：实际Admin私有引用续接、5979完整覆盖/3014Node20/604SDK/11故障12重叠另1SDK/精确三函数site与14进程已验证，完整公开入口仍未启用。

## 当前问题

native publishOperation最后检查validateProductPublication(next)，该函数校验主分类及旧category字段，但不读取当前catalogTaxonomies，也不验证subcategoryIds是否属于当前目录。正常分类保存有planProductSubcategorySave保护；历史损坏/无效归属若一直未改该字段，仍可能走到最终发布。恢复入口不能靠用户手动改无关字段触发校验。

## 决策与约束

继续使用原最终事务，读取当前主分类的目录；无目录行使用已有initialCatalogTaxonomy约定，有行却损坏则明确拒绝且不猜默认。复用storedCatalogTaxonomy与readProductSubcategories；既有archived子类可保留、主类下未分子类及旧Headphones category也按现有规则处理，不强加、清空或重新分类。

全部读取在3个原最终写入（product、原complete根、唯一引用proof）之前完成。没有新增共享锁、目录写入或assignmentFence递增。目录正常管理接口已经保留既有child id/slug，只允许改名、排序、archive及增加；已有归属因此可继续使用，批量发布不需要为此互相写同一目录行。JSON/HTTP探针不能证明真实CloudBase MVCC，实际冲突/P95仍是发版门槛。

返回结构化classification问题：非法归属指向subcategoryIds/remedy=classify；目录损坏指向同字段/remedy=system-repair。未知读取IO继续抛出，不能当成“目录不存在”。主分类缺失继续用原MISSING_CATEGORY提示。此步骤只补最终原生校验，不启用UI或新的发布调用；来源review回执与最终caller在后续MIU接。

## 测试与退出条件

先在真实原生发布夹具中复现：未知子类、坏赋值、坏目录当前会发布，期望拒绝且所有字节/写入计数不变。补正常空归属、已archive子类及旧Headphones分类保留、目录IO失败不吞。保留原single/27图、唯一proof、丢回应/坏ACK/取消/源或角色变化的回归，安装SDK验证最终事务由15变16个文档操作且仍3写。review、相关/组合测试和类型/SDK通过后继续最终caller，不能据此称真实20件发布已完成。


## 实施与验证

原最终写入前读取当前taxonomy，使用同一shared读取规则校验归属；未知/格式错误赋值返回classify，目录存在却损坏返回system-repair。缺行使用已有默认目录，未知读取IO抛出。没有目录写入/assignmentFence变化，仍3个原最终写，现有completed回执重放仍先返回而不追加校验写。

3项业务红测均证明原实现错误发布；补齐后8新增、326原生/529相关、5987完整包与脚本、实际Node20 3022、19包类型+E2E类型、standing SDK及两文件Biome/diff通过。正例包含无subcategoryIds或显式空数组、已有archived child及显式productFamily=headphones+旧wired category；均保留原分类字段和值，不新增/强加子类。缺主分类仍按原MISSING_CATEGORY，不自动把只有旧category的行补成显式主类，旧数据如何准入/修复仍由P5统一处理。

5变异全检出、10重叠失败、单源码SHA恢复，恢复后529/610SDK通过：整段删除、坏目录降为默认、错误拒绝已有archive归属、吞IO为缺目录、丢失正确remedy。610=原604+6安装SDK控制：2坏赋值/坏目录零写，archive归属仍3原写且目录不变，2个目录coded/malformed读取错误不吞。原single/27图片最终事务现16文档操作、3写、0图片读取，全套最高98不变，原9ACK回滚/丢回应/重复完成仍保留。mock原本没有catalogTaxonomies空集合，在新探针初始资源夹具加上既有表；未创建新业务集合。

人工review/simplify/humanizer实际核对两改动文件与shared taxonomy读取、原分类保存/目录管理事务、原最终media/source/current/TTL/receipt。目录管理保留既有child ID/slug，archive可保留旧归属，故此次不增加发布间共享目录写冲突；这不证明真实CloudBase MVCC/P95。文案明确Headphones正例带显式主分类、metadata SDK与真实PNG分开，避免误称所有历史分类已经修复。没有改source/raw、来源review标记或公开API/客户producer。

本步以实际编译native+安装SDK验证原生校验；精确三函数/site产物仍为d67cf6ab。下一caller打通完整发布小流程时再构建新精确产物并跑公开读回/回退。未部署、未测试真实三时钟/20件，原UI P1、review/live/新图/P5/fallback和真实云验收继续，fullDeliveryReady=false。
