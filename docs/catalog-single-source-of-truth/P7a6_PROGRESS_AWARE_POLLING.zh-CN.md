# P7a6：有持久进度时继续只读等待

## 运行问题

`runPreparation` 的 `polls >= 4` 同时承担退避次数和停止条件。同一 worker 在 active lease 内逐张持久化图片检查或证明，status 返回更大的 checked，但浏览器仍会在第四次查询后暂停。P7a5 外盘健康复跑（bounded-attestation-formal-r3）10项通过、20件项90秒失败；8件确认、3件 running，存在 PREPARATION_RESULT_TIMEOUT。这个 MIU 修复可独立复现的等待问题，不把它认定为全部耗时的唯一原因。

```ts
if (mode === 'poll') {
  if (polls >= 4) return result('paused');
  polls++;
}
```

## 数据与约束

| 值 | 生命周期与边界 |
| --- | --- |
| jobId / productId / createdAt | 原准备任务；只查询原 jobId，不创建新任务 |
| leaseVersion / attempt | 当前 worker 租约；延长只读等待要求与最近认可的检查点相同 |
| inputDigest / contentGeneration | 同一候选；已有报告时必须完全一致 |
| media.checked / verified、attestation.checked | 服务端持久进度；总数不变，计数不倒退，invalid/retry 为零 |
| idlePolls | 本次浏览器等待；连续四次没有持久进度后暂停 |
| polls | 本轮只读查询退避；600/1200/2400ms，进度不能把每轮间隔降回600ms |
| 120s / 64 requests | 本次整体浏览器预算；任何进度都不能重置 |

心跳 updatedAt、leaseExpiresAt 增长不算进度。active lease 的进度只能触发 status，不授权 continue、retry、cancel 或 publish。原 queued/released lease 的自动继续仍要求递增 leaseVersion/attempt 及原严格持久进度证明。

## 选择与代码落点

在 catalog-preparation-api.ts 将可验证的候选范围和单调计数检查提取为共用函数。已释放租约和同一运行租约分别检查自己的租约条件。增加独立 idlePolls；只有经过全部条件验证的媒体/证明进度将它归零。保留最近认可的检查点，坏计数或另一候选不能通过下一次回升被当作新进度。所有调用仍经过原响应解码和已登录 API，权限失效立即停止。

不增加并发或总时限，不放宽媒体合约，不把 ready 当成发布成功。前端正确等待不会减少后端事务量，冷20件与云端P95仍需单独验收。

## 反例与验证

先运行：同一 active lease 连续六次媒体或证明进度后 ready；原实现应第四次后 paused。坏租约、候选摘要、代次、总数、倒退、缺报告、invalid/retry、只有心跳不得延长。持续有效进度仍在120秒/64次停止。用真实本地 PNG、原 worker、JSON DB、签名 Admin HTTP 在逐张证明持久化后阻塞，验证超过四次只读查询仍能等到 ready，且不额外 dispatch、不发布、计数零、分类不变。finally 放行并等待所有本次 worker 后再移除临时库。

定向检查后重新 review，两浏览器组合、完整本地测试、类型/构建/SDK gate，再重跑原生产构建20件90秒断言；尚未通过前 fullDeliveryReady=false。


## 反例结果与审查

初始95项中90通过、5失败，仅新增两条持续媒体/证明、两条总预算和真实PNG active lease用例失败。旧实现前四次均有持久进展，仍返回paused；总预算用例在5次请求提前停止，未走到其64次/120秒边界。实现后95/95、0跳过通过。真实HTTP用例在持久化证明后逐张阻塞同一worker，超过四个不同的checked状态后ready；仅一次continue，其余status，无start或publish，原图片/分类不变、引用计数零，finally放行并等待owned worker后移除临时数据。前端测试类型检查通过。

Standards：实际审查 catalog-preparation-api.ts、对应单测、native-flow及原worker、authority和jobs的租约判断。共有候选/计数判断提取后，原queued续跑仍要求已释放且递增的lease/attempt；active等待另要求相同lease/attempt。检查点只在认可进度时更新，防止坏响应成为下一次进度基线。600/1200/2400ms退避与idle停止分别计数，总预算不重置，无新增SDK、DTO、数据写入或分类行为。

Spec：本MIU只能修复进展中的提前暂停；未减少后端事务，不承诺冷20件或P95已达标。静态审查未见此处新增权限/发布绕过，原未完成的组合门槛保持开放。文字复核实际查看上述源文件与本MIU，纠正P7a5“复跑中”为已失败及实际阶段时序，核对了95项数量、原4次停止、120秒/64次和无数据变更的范围。


## Node20与生产构建结果

Node20.19：等待/真实PNG/完整worker组合193/193、0跳过。SDK gate通过，三个原云函数构建通过。生产构建formal-r1为10通过、1失败，仍是20件90秒未完成，8件确认、4件running；完整保存了失败前DB和187条安全阶段记录，唯一明确错误是测试注入的BUSY。28次准备continue平均7355ms、最大8879ms；21次发布continue平均2316ms、最大8912ms。原11份报告哈希恢复一致，独占临时库/媒体/构建/进程清理。该结果表明只修等待不足以解决冷批量耗时，继续检查后端事务，不重复发布真实20件。fullDeliveryReady=false。
