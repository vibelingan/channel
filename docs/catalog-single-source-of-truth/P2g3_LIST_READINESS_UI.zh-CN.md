# P2g3：现有商品列表接入检查范围与恢复

## 运行场景与选择

P2g2提供四种后台摘要条件，现有CollectionView没有入口；它也曾把失败读取留在可操作的缓存页上。管理员需要在同一张表里找到问题商品、修好后重新检查，再回到可用范围。直接把默认查询切成normal会隐藏尚未审计的历史商品，因此本单元增加显式all。未传catalogReadiness的旧API行为保留；现有UI在影子阶段默认传all。P5审计、修复、索引与性能门槛完成后才能切换默认严格准入。

```ts
// 原列表只绑定family/subcategory/page，无法隔离不同检查范围的响应。
const queryKey = ['list', collection, family, subcategory, checkStatus, page, search, filter, sort];
// count采用同一checkStatus/search/filter，分类轴单独改为needsClassification。
```

all在CloudBase用既有expr传常量true，在JSON直接接纳；其余四范围不变。范围在后台count与分页之前生效；没有浏览器拿一页后再筛选。normal仍保留已有公开行，不能因新来源blocked就隐藏旧公开版本。检查摘要不授予发布权，也不代替完整内容、分类、权限或媒体的提交校验。

## 数据与技术约束

| 值 | 例子 | 存续与作用范围 |
| --- | --- | --- |
| checkStatus | all/normal/issues/preparing/unchecked | URL与当前列表；严格枚举，旧/坏值回all |
| 列表缓存身份 | collection/family/subcategory/status/page/search/filter/sort | ReactQuery读缓存；不同查询的晚到结果互不覆盖 |
| 分类计数身份 | status/search/filter | 独立并行读；跨family统计当前筛选下未分类商品 |
| 选品 | 实际商品ID | 当前查询；切换范围、排序、分页等清理，历史回执另保留 |
| list结果 | items/total/page/pageSize | 确认页身份、非负安全整数计数、唯一非空ID；不推断count与page为事务快照 |
| 分类保存 | 已选ID+产品updatedAt+taxonomy revision | 沿现有受版本保护的分类接口；不改变内容检查或发布状态 |

复用现有ProductFamilyTab、共享Select、表格、PreviewModal、ClassificationDialog和分类编辑器。没有新页面或存储字段。query key绑定范围解决晚到响应，不另建一套请求状态机。count与page是独立数据库读取，不能要求total始终大于等于返回行数，否则正常并发插入也会被误判为坏响应。

## 实现与拒绝的替代

主查询及Needs classification计数使用同一检查范围、搜索和结构过滤；全局供应商待审提示只在未缩窄的all视图显示，避免把全局数量冒充当前范围计数。URL保留family/subcategory及其他参数，back/forward恢复范围并清理选品。新排序从第一页开始。

issues/preparing/unchecked禁用行Publish、桌面/移动批量Publish及分类Save and publish，提供Preview/Edit检查或修复说明；仍允许分类单独保存。这个保护也进入分类确认条件，不把发布意图静默转成只保存分类。all/normal继续走既有后端发布校验；稳定操作协议仍属后续P3，不能凭这里的按钮保护声称所有入口已完成。

读取失败或形状不明时显示Retry list/Retry count，不报0条成功，不同时显示No records；缓存页的写按钮和分页不可继续使用。浏览器实际红测发现原PageJump仍可用、移动Actions里的Publish漏了保护，均已修正。合法空结果仍显示0 records。Preview关闭使列表及相同范围计数失效，准备完成或编辑失效后刷新到正确范围。

不采用前端分页后过滤、每行source/SKU/job读取、失败时保留旧可写页、默认隐藏全部未审计旧商品或另建批量准备平台。列表目前仍返回完整商品行，**有界行投影尚未完成**；后续P2g4同时补齐列表摘要及Edit/Preview按ID取完整记录，避免把缺字段的摘要传给表单。没有将轻量条件查询误称为有界响应。

## 红绿测试与故障检出

隔离无头浏览器挂载实际CollectionView及共享组件，使用实际签名admin HTTP handler、JSON数据库、媒体存储和本地准备worker。仅负路径在HTTP边界控制503、坏成功或延迟；不是模拟列表业务。路由为本地catalog-list-test组件夹具，正式页面路由与部署浏览器验收仍在P6/P7。

12个浏览器场景覆盖：20选品切范围、请求/计数晚到、缓存刷新失败与两种重试、坏200、不误报空、390px布局与分页、移动发布菜单、375px/20选品展开菜单、family/subcategory/search/OR及历史、桌面/移动分类只保存、实际Edit修复→Unchecked→Preview准备→normal、无分类旧商品准备后保持published/family/category/subcategory字段缺失。只读场景比较整份JSON字节；写场景核对实际产品及catalogDetailApprovals/catalogDetailVariants，不用错误集合名作空测。临时夹具均由after关闭浏览器/服务并删除。

最初缺状态选择器红测；后续PageJump与移动Publish有真实断言红测。扩展流程首轮8过/3失败中，两个分类样本缺用于CAS的updatedAt，另一个下拉框点击到水合前原生select；补真实版本样本、等待实际button，不改产品保护以迁就样本。新增请求等待的TypeScript可选data提示另修，日志保留，不算业务缺陷。

12项源码反例最终全部检出：响应页身份、重复ID、主范围、计数范围、选品清理、Preview刷新、失败跳页、移动发布、分类发布、缓存写入口及两种移动菜单定位。首轮选品反例存活，说明只断言“20 selected消失”不足；加强到零选品、各行未选中、切回all仍未选中后检出。完整重跑每次保留8–24正控且有1–7失败；最终测试调整后选品及两项API反例再验，仍检出。finally恢复源码并逐文件比较SHA；首轮假绿没有算作成功。

七组最终回归为DB1202、shared305、admin637、local501、public131、sync304、site719，共3799项，零失败/跳过/取消。前端首轮717/718的唯一失败是共享Select清单固定4，新增入口后同步5；随后完整718重跑通过；补移动菜单边界后完整719再次通过。后端六组无后续源码改动。Node20后台两文件39项、客户端两文件16项通过；最终文案改为通用“The list…”后API反例再验。六个后端消费者类型、Astro215文件零错误/警告8既有hint、15完整文件显式Biome、SDK及diff检查通过；构建与精确提交证据以对应review侧车为准，不使用有无效--silent参数的precommit输出当lint证据。

可复核命令/记录位于output/pricing-clock-repair-2026-10-13/p2g3：list-full-gates.py与逐包full日志，list-site-final2.log，list-user-flows-run1/2/3.log，fault-rerun/list-fault-summary.json，fault-final-selection、fault-final-api、fault-menu及其恢复manifest，list-node20-backend.log/list-node20-client-final.log，list-sdk-gate.log、list-biome-final3.log。桌面基线与当前截图分开保留，移动截图list-current-mobile-issues.png；关闭与展开菜单分别实测375/390宽度及按钮左右边界，表格沿既有内部滚动。视觉复核发现原390px菜单把页面撑到429px，补断言得到11正控/1失败；菜单改为相对整条选品栏右侧定位。375px的20选品换行反例会检出错误的details局部锚点，不能只把left改成right而忽略换行。最终截图宽390，原429截图另存。

## 复核与继续事项

逐一检查15个代码/测试文件及原选择、分类CAS、getRecord身份、编辑保存和Preview接口接缝。CloudBase沿既有expr与serializer，没有新SDK方法、类型shim、依赖或资源；官方/安装契约沿P2g2证据，新增all实际经双安装serializer、真实列表主体和Node20测试覆盖。认证继续沿现有JWT与当前用户权限，未接入另一套Web会话。全量count不当并发快照、受管摘要不当全文权威、缺published不当false，均保留。

写作检查实际比对本文件、实施记录、product-check-status与api文案：将通用list错误中的“Product list”改为“The list”，核对12反例、12浏览器、3799回归、39+16 Node20、分类/发布字段及fixture边界。没有借技能名称宣称完成。

有界列表行/完整Edit读取、旧版本与公开损坏审计、稳定操作、合法大媒体提交、认证过期草稿/占用恢复、历史resync、性能及test实际20件发布恢复继续。没有部署、客户商品写入、新分支/worktree/PR/push；fullDeliveryReady=false。
