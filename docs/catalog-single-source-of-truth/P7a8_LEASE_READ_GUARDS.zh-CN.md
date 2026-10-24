# P7a8：候选检查里的租约守卫只读，返回值绑定原任务输入

## 运行问题

P7a7移除每图重复心跳后，较重20件仍90秒未完成。inspectCatalogPreparationJob 先renew，然后把renew当作readCatalogPreparationCandidate的每一个权限回调。普通手工候选含嵌套preview，单次inspection共5次renew；来源候选为3次。每个renew事务重复读完整来源输入并改job，即使只是确认同一worker还有效。9图/3worker的手工完整流程有6次inspection、30次renew。私有检查不是业务进度，不必在每个读守卫都改job。

```ts
const renew = () => manageCatalogPreparationJob(authority, { action: 'renew', jobId, lease });
const initial = await renew();
return readCatalogPreparationCandidate({ productId }, async () => {
  const current = await renew();
  return current.ok ? { ok: true } : { ok: false, code: 'CONFLICT' };
});
```

## 数据与约束

| 值 | 来源与检查 |
| --- | --- |
| jobId/productId | 初次原renew返回；产品ID不由外部调用方传入 |
| 原inputDigest/contentGeneration | authority.currentLeaseScope从内存grant与新鲜完整job匹配后给出，只在后端使用 |
| job记录 | 每个读守卫通过原db.get读单行，再经readCatalogPreparationJob严格解析与当前时间检查 |
| nonce/leaseOwner/leaseVersion/expiry | authority用原grant匹配；过期、取消、被接管及序列化能力不能通过 |
| 候选inputDigest/contentGeneration | readCatalogPreparationCandidate两次完整输入读取后的稳定摘要；返回前必须与原scope完全一致 |
| ready/publish/计数 | 本函数始终unsealed；原bind/checkpoint/attest/finish/发布事务继续完整校验，不在此授予 |

初次renew保留，既检查当前来源输入又续120秒；每个嵌套读守卫只验证新读job的完整shape、当前lease、原任务/产品。将首次有效scope保存在显式局部对象内；候选读取结束后，摘要/代次不等于scope就CONFLICT。不能只看job代次：人工直接改名称/描述可能没有更新代次，仍需最终完整摘要对比。候选读取器本身在结束前再次读产品和全部输入，读取过程中发生变化也会拒绝。

## 实现选择

修改catalog-preparation-job-inspect.ts，并在db facade增加readCatalogPreparationLease目的明确的服务端只读函数。它先检查内存grant绑定jobId，再经adapter原get单行读与既有readCatalogPreparationJob严格解析，最后调用authority.currentLeaseScope。通用db.get刻意禁止私有jobs集合，首版试用它返回UnknownCollectionError；没有注册私有集合或放宽通用CRUD，而是沿用已有私有lease点读封装模式。无新SDK方法、DTO、集合、迁移或job identity算法。readonly检查不在事务里续租；下一步原事务仍写同一job，因此与取消/编辑/接管的竞争仍由原当前能力和CAS解决。两个读之间发生竞态与原renew返回后的竞态一样，不能把任何一次读当成最终提交许可。

不删初始renew；不靠代次代替摘要；不从浏览器提供产品ID/摘要；不放宽共享图片、当前候选、属性、价格或分类规则。不会让候选ready冒充可发布。

## 反例与验证

先补手工和来源候选：成功一次只允许1次renew及1次mutationRevision增长，业务行不变；原实现5/3次应失败。初次renew后直接改合法名称或描述、保持代次不变，候选必须CONFLICT；这是最终scope摘要比较的独立反例。租约在来源读取中到期或被接管、原job被篡改nonce或shape时，也必须拒绝；既有取消/编辑/伪造/序列化/105图片与私有字段检查继续。

实现后把最终摘要比较临时删掉做故障注入，两条直接合法名称/描述替换测试必须失败，随后恢复源文件hash一致。9图完整流程的独立心跳上限从30降到6（6次原inspection），像素/证明/媒体分轮不变。Node20、HTTP/PNG、kernel、cancel/edit/ACK/共享计数与原20件90秒生产构建继续。全量、test部署与性能验收尚未完成，fullDeliveryReady=false。


## 反例边界修正

第一轮18项15通过、3失败：两条心跳数量红测正确，第三条把“同一来源图片刚被正常采用、尚未绑定检查计划”误要求CONFLICT。实际preparation input摘要包括产品、来源、observation、主链接，不把可正常采用的catalogSourceLinks当成内容编辑。该时点应读到最新图片而保持unsealed，已有media plan/seal之后的替换仍由原planDigest与最终复查拒绝。已把该条改成正向兼容测试，最终scope摘要故障注入使用合法名称和描述的直接替换；没有为了测绿修改已有业务行为。


## 失败状态兼容

只读首版在并发编辑时正确返回CONFLICT，但既有断言发现job仍running，原多次renew会把它标stale并释放租约。不能放宽该断言。现对候选读取冲突/最终摘要冲突单独走原renew事务结算；取消/过期/接管仍由原能力拒绝，正常成功路径仍仅一次心跳。结算异常返回UNAVAILABLE，不声称ready、stale已落盘或远端已取消。新增故障注入检查只发原renew、不取消别的任务。最终摘要判断被临时移除时，合法名称/描述两条反例均失败；源文件哈希恢复一致。


## 验证与两轴审查

修正边界后的RED为19项17通过/2失败，仅心跳5/3次而非1次的两条失败。第一次实现使用通用get读私有jobs被UnknownCollectionError正确拦住；改为先校验原内存grant绑定jobId的专用服务端facade，保留集合未注册。接着既有编辑用例发现旧stale状态副作用，已按原事务只在失败路径结算，未放宽断言。最终24/24，Node20.19 kernel/authority/jobs/媒体保护/完整worker/HTTP-PNG/前台等待556/556、0跳过；含105图、DB重开、来源替换、ACK与会话撤销。源码故障注入2/2按预期失败且恢复hash一致。所有工作区/E2E类型随后通过，正式构建重20件继续。

Standards：实际审查job-inspect、db facade、authority、readCatalogPreparationJob、候选初末完整input读取、后续worker的planDigest和最终commit，以及新增/既有测试。没有改generic CRUD、集合注册、身份、类别、价格、media hold、计数或seal；没有SDK shim/API扩展。scope是后台原authority返回的冻结对象，浏览器不能构造，返回候选仍不是report/ready。初始renew仍原事务；其余lease检查单行只读，正常路径job只改一次。冲突结算不复活取消或接管的租约。

Spec：保持合法采用最新来源图片的既有行为，同时内容直接改动即使代次没更新仍拒绝；已绑定media计划后改变图片仍由原完整worker的计划检查拒绝。静态及反例审查未见本单元遗留P1/P2；全局耗时和最终组合门槛仍开放，不能宣称用户所有正常操作已经零错误。文字核对实际查看上述五处源/测试和本MIU，纠正“换绑定一律冲突”为绑定前合法采用/绑定后严格计划检查，核对了19、24、556与初末摘要和失败状态结算。fullDeliveryReady=false。


## 重样本结果

lease-read-guards-formal-r1：10通过、1失败，原90秒时12件发布、12个准备完成、4个准备running，另4件未开始。已完成12个准备全部attempt=3，单组准备18–23秒，39次continue均值6418ms、最大8775ms；唯一明确错误仍是注入BUSY。11份报告哈希恢复，独占DB/构建/进程清理。该轮再次证明单纯减少守卫写入不足以达到重样本门槛。9张共享图后续组已有保护和像素证明，仍被当作4张物理检查分成3轮；下一单元只优化有效保护缓存，保留物理检查上限。fullDeliveryReady=false。
