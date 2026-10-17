# P3e2a：先确认商品实际写入，再记阶段成功

为P3e2自身保存回执准备时，已观察到saveCatalogProductInCloudBase对产品create/set和update不检查返回值；身份/分类的部分写点已有检查。必须先验证产品写点，避免商品没有更新却返回saved、随后把错误结果记进操作回执。此单元沿现有事务补齐ACK，不引入新的保存/审批状态机或HTTP入口。

先用原生适配既有事务夹具复现：产品set/update返回updated:0、错误码、错upsert ID时不得返回saved，所有先前身份写入也必须回滚；正常既有更新和正确upsert仍通过。保留无操作的真实语义，不能因SDK对无变化写入的计数而把已完成重复操作报错。回滚后相同请求可安全重试。

现有官方Node SDK更新文档与安装@cloudbase/node-sdk3.17.2→@cloudbase/database1.4.3已核对：实际transaction/index.js通过CollectionReference.doc构造同一DocumentReference并传transactionId；document.update使用database.modifyDocument、merge:true/upsert:false，返回updated:res.data.updated。set的事务分支返回updated和upserted数组；不能拿旁边旧transaction.js或另一SDK形状代替。公开文档没有详列ACK字段，以安装源码和实际SDK sender探针为精确依据。Context7不可用；CloudBase账号当前需重新登录，但公开文档工具可读，本地工作继续，无需在这里启动授权。

使用同一小型写回执检查函数，保留错误码以便原事务冲突处理；未确认立即抛出，不能在任何后续job/receipt写入后才发现产品没有落库。只要求单文档正常update的updated=1，set允许正常既有更新或目标ID的upsert。代码与实际Node20打包SDK故障读回都验证后，再继续P3e2保存与回执原子提交。整体原发布恢复P1尚未关闭，fullDeliveryReady=false。


实现与审查：产品create/set、update、新slug/SKU身份set、旧身份remove在原事务内检查单文档回执；coded answer保留原错误码，失败抛出使之前的身份/商品更新一起回滚。不新增读取、集合、SDK方法或权限写。原actor分类fence整段与HEAD逐字节相同；自动审批曾把它误认成新增副作用，拒绝的尝试没有执行，随后以保留原段的补丁完成。无改动计划跳过空产品update，JSON在全部分类/建议验证后才跳过无fence的文件写；明确要求的原权限fence仍执行。

先红后绿：原生最初5个产品写回执失败，扩展后15项失败；审查再发现提前no-op会绕过分类权限及丢失明确fence，各2项红测后修正。最终三文件274通过，Node20同274通过。旧4b88e49真实编译后台+native adapter+实际SDK经仅替换HTTP的探针，在“未确认商品写入不得成功”业务断言失败，不是导入/认证错误。

scripts/product-write-artifact-probe.cjs为默认smoke:functions的admin强制步骤。实际打包函数/原生adapter/SDK完成正确upsert创建、商品更新、slug/SKU改名和旧身份移除；13种零计数/错误ID/错误码写回执全部拒绝、事务store逐字节不变，再同输入重试成功。只有内存假后端写入，禁止真实socket/fetch。默认驱动实际编译去掉ACK的源模块，必须失败；删除smoke接线亦使驱动失败。未将此称为云端MVCC、真实数据或性能验收。

16种源码故障全部检出，51个重叠失败断言，4文件finally恢复并核哈希；证据product-write-ack-fault-results.json。恢复后后台全量3244（shared309、DB1342、admin637、local521、public131、sync304），全部脚本488，Node20产物驱动24通过。全部相关19项目types、Astro216零error/warning与8既有hint、8完整文件显式Biome及被忽略原生函数的格式化源段检查、standing SDK通过。站点全量797通过（含实际浏览器组件），相关全量合计4529（后台3244+站点797+脚本488）。精确提交构建结果在后续审查记录，不能提前记成功。

复核9代码/测试路径与消费者，包括原planCatalogProductSave、分类/建议fence、native事务提交/错误处理、JSON文件锁/回滚、HTTP create/update、默认smoke及实际SDK sender。simplify保留同一个检查函数，删除重复的native no-op提前返回，权限验证后由原计划跳过空update。文案把“保存完成”限定为“写入有ACK且事务完成”，把模拟后端与真实云端区分。原发布丢响应P1仍需P3后续阶段修复，fullDeliveryReady=false；无test部署/真实商品修改。
