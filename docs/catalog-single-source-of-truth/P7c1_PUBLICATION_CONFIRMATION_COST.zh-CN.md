# P7c1：发布确认复用刚返回的完成状态

## Runtime Problem

真实隔离样本中，已准备单件发布用了7.8–8.4秒；每次正常发布包含me、start、continue、get、anonymous-public、get共6个入口请求。continue已经返回经过完整合约校验的complete状态，确认器仍立即重新GET相同任务。普通已发布文字保存还有照片准备重复工作，真实23–27秒，本MIU只处理重复确认读取，后续单独修复媒体准备，不能称整体性能已好。

当前代码：
```ts
if (run.reason === 'committed') {
  await checkPublication(run.scope, { request, fetch: publicFetch });
}
```

## Data Shape

initialStatus是仅存在内存的一次服务器完成响应，含productId/operationId/inputDigest/intent/revision；不持久化、不改变数据库字段或历史回执。匿名读取仍锁定原revision，结束后仍重新读取原任务。

## Technology Constraint

浏览器可以在任意await期间被下架、换账号、换来源或得到迟到回复。开始时的完成状态不能替代结束时的当前性检查。输入必须严格解析并复制，不能保留可变引用。旧的恢复/检查入口没有刚返回状态，继续使用两次任务读取。

## Design / Flow

```ts
initial = supplied === undefined ? await query() : readPublicationStatus(supplied, scope);
await readAnonymousDetail(initial.completion.revision);
latest = await query();
assertSameCurrentRevision(latest, initial);
```

## Best-Practice Fix

只在batch刚收到committed时传入run.status。验证身份/范围/摘要/intent后，用它作为原先第一读；保留匿名真实访问、最后一次任务查询、会话守卫和持久化恢复。无新增SDK方法、存储写入或权限。

## Alternatives Rejected

跳过匿名访问会把“已提交”错当可公开；跳过最后任务查询会遗漏并发下架；提高8秒和60秒目标不能修复慢请求。

## Risk / Test

新增测试应先在旧代码失败：合法状态只需要一次额外get；错商品/任务/摘要/intent、额外字段均在公开IO前拒绝；公开404和最终换版本不能确认；并发下架仍historical；输入对象在await中变化不污染已捕获状态。保留原无状态两读测试。

执行：从原worktree用Node20+tsx运行catalog-publication-check.test.ts和catalog-publication-batch.test.ts，再进行相关发布/分类/编辑组合及类型、lint、实际test重验。此时还没有实施或部署性能修复，不改当前已恢复客户商品。

## 实际结果

原版本红测43项：33通过、10个新增断言失败。实现后确认器及批量协调器完整91/91通过，0跳过；4文件Biome与全站测试类型通过。人工复核了两份源文件和两份测试，验证恢复入口仍两读、正常路径仍匿名读取和最后读取、错误身份/摘要/回执及并发下架不能确认。措辞修正为“每件少一次重复读取”，不称云端性能已达标。未部署；后续P7c2仍需独立通过。
