# P2g4b2：列表响应字节预算

## 边界与选择

基线2594a53已完成22文件审查、三函数及15页站点精确构建、Node20产物与health SHA核对、打包后的新/旧列表及完整get和检查修复组合流程。保持原目录和分支，继续本地实施；没有test部署或客户数据写入。

新摘要协议每行JSON最多8KiB，最大100行；含ok/data envelope整页最多1MiB。普通20行上限约160KiB加包络。原get、来源记录、网站候选及mapping数据完整保留。字段投影仍在原生get上执行，预算控制HTTP返回；不假称它给数据库内部读量或P95提供了证明。历史选中元数据的数据库读量仍需P5审计和实际性能门槛。

不采用静默裁剪价格/属性、整页报错、少返回行却保持原总数、逐行重新读完整来源，或新增存储表。正常小行逐值保持；超大元数据只让该行显示“View in Preview”，不误报为价格不可用，不把元数据体积当内容校验失败。使用已有Edit/Preview完整读取入口，后续操作仍在服务端完整校验。

## 数据与交互

| 情况 | DTO | 允许的路径 |
| --- | --- | --- |
| 整行在预算内 | 原固定字段/值及版本marker | 保持既有行为 |
| 只有附属元数据超限 | 保留原ID、名称、分类/子类、CAS/状态和审核/source身份；标记limited | 明确“View in Preview”；Edit/Preview正常；分类/发布仍由完整服务端记录校验 |
| 核心字段也无法保留 | 有界显示名称、完整正常ID、可保留核心字段；limited+coreIncomplete | 行和已选批量快捷写禁用，保留清选/取消选中及Edit/Preview；不伪报Needs classification或Disabled |
| 摘要协议损坏或返回超预算 | 客户端INVALID_RESPONSE | 既有Retry/未知数量/缓存禁止写；不启动保存 |

源分类suggestion的消费者还会读取alibabaSourceReview.sourceCategoryId。即使省略整个review的大数组，也必须保留该嵌套ID及直接sourceCategoryId原有一致/冲突语义，不把一个值复制成另一个来掩盖冲突。只读列表不推进generation，不保存截断值，不创建准备/审批任务。

正常记录ID来自既有UUID/最多200字符的产品操作合约。不可寻址或超过该合约的损坏ID不截断、不换成hash假ID，列为P5历史审计修复项；不能把这类损坏宣称成正常可发布记录。要验证该前提后才切换默认历史范围。

## 预算算法与验证

先固定投影，再有限遍历JSON值估算确切编码字节；长字符串先以长度下界拒绝，不对超大整行做JSON.stringify或展开整棵深树。保留转义和UTF-8实际字节，迭代栈/节点与深度受预算限制；最终拷贝和页 envelope再核验。附属字段失败时构造核心摘要，每个保留值和总核心都受预算限制；缺published保持缺，true/false不混淆。非法/不支持JSON值不冒充小值放行。

红绿测试覆盖ASCII/中文/emoji/控制字符8KiB精确边界及多一字节、100件大元数据、深/大字段快速拒绝、不得完整序列化超限行、原get/磁盘不变、分类建议直接/嵌套ID与冲突等价。实际浏览器验证可打开完整记录并保存修复、不会报假价格、核心摘要不足时桌面/手机所有快捷写禁止且可清选恢复；原批量/晚到/重试流程组合重跑。测试须用实际admin/JSON和原生列表，反例证明预算、源身份、快捷写及fallback保护有效。

本节是本单元实施检查，不预填通过。P3至P7门槛继续，fullDeliveryReady=false。


## 执行与复核

8KiB行预算保留24层，1MiB页包络保留32层。实际复核发现447字节的30层元数据虽然很小，也会因包络增加深度使整页拒绝；新增真实admin与纯投影红测（1正控/2失败），改为行预留包络深度后通过。核心名称只作有界显示，完整get仍返回原文；直接与嵌套来源分类ID独立保留，冲突不被归一化抹掉。

浏览器按真实表单完成大元数据Preview、分类确认保存、Edit修复并读回完整原值；1440/390宽度核心不足时逐项快捷写禁用，Edit修复后原选品重新可分类。手机展开Actions后Clear selection曾被菜单遮挡，真实点击失败，已把原菜单定位到整条选品栏下方，几何断言与截图core-summary-mobile.png证明可见且可清选。没有force click或先关菜单绕过问题。

初始后端11项4正控/7失败、JSON8项7正控/1失败、客户端45项40正控/5失败、3浏览器新流程全部失败。第一次运行路径错误导致0匹配不算红测；绿测第一轮客户端72项70通过/2失败，分别是夹具把名称附注当精确单元格文字和上述真实遮挡。类型中的TextEncoder实例类型、精确optional、完整CategorySuggestion夹具及Biome语义output均修复。首次site全量在tsc前置失败，SDK首次也因set-e前置失败没有执行，均保留原日志，不冒称通过。

最终相关全量4359项：shared309、DB1215、admin637、local510、public131、sync304、site766、部署/脚本487，全部0失败/跳过/取消。站点用实际GALLERY_BROWSER_TEST=1。25反例完成后，后端65和客户端72正控再次通过。Node20后台26、客户端45通过；Node20产物驱动4目标通过，另19项按name pattern未选，不把未选项算通过。全部packages/三函数/local类型、Astro216文件0错误/警告8既有hint、16完整文件显式Biome及被仓库忽略的原生列表函数逐字格式比较、SDK合约与diff检查通过。

原生最终产物增加常驻scripts/admin-list-artifact-probe.cjs，在原smoke-function-artifacts命令中无开关执行；既有CI与test部署命令自动包含。保留实际编译handler、原生adapter和安装SDK，只替换HTTP transport；完整get、固定field/EJSON、auth/count/列表共3次读取且无逐行读、普通/大/深/核心行、旧完整列表和零写入均实际断言。所有凭据是独立假值，真实socket/fetch禁止，裸目录finally清理；不注入源JSON适配器。旧2594a53产物实际在“compiled native projection must bound row large”预算断言失败，确认该烟测可检出旧版本缺陷。新精确提交构建/健康SHA和整合小流程在审查后另记review侧车。

修改后的产物驱动夹具使用实际admin/public esbuild编译和真实tsup外部依赖配置，未用假admin逃过新烟测；none/missing-manifest/broken-loader/wrong-import-map四模式通过，none另断言actualBundledNativeAdapter输出。删除常驻接线使实际驱动3正控/1失败。

25项源码反例均有正控和断言失败，无导入/编译假红；四旧完整读取/协议反例再次经过实际浏览器。65个失败断言存在重叠，不能当作65个独立产品缺陷。8个生产文件finally恢复并逐一核对SHA256，没有并行源码写入。全部临时DB/浏览器/裸产物夹具清理，只有本地证据文件保留。

| 故障 | 正控通过 | 检出失败 |
| --- | --- | --- |
| native-field-bypass | 25 | 1 |
| future-private-field-leak | 25 | 1 |
| nested-copy-alias | 25 | 1 |
| row-budget-bypass | 16 | 10 |
| eager-oversized-serialization | 25 | 1 |
| utf8-counted-as-code-units | 22 | 4 |
| row-depth-without-envelope-space | 24 | 2 |
| server-page-budget-bypass | 25 | 1 |
| core-incomplete-flag-lost | 23 | 7 |
| nested-source-category-omitted | 68 | 3 |
| source-category-conflict-normalized-away | 69 | 2 |
| core-primary-source-omitted | 67 | 4 |
| limited-metadata-shown-as-quote | 45 | 2 |
| limited-metadata-photo-used | 44 | 1 |
| client-row-budget-bypass | 44 | 1 |
| client-page-budget-bypass | 44 | 1 |
| incomplete-marker-without-limited-accepted | 69 | 2 |
| core-quick-write-guards-disabled | 2 | 3 |
| recovery-link-opens-wrong-mode | 2 | 2 |
| mobile-menu-overlaps-clear | 3 | 1 |
| summary-accepted-as-complete-get | 68 | 4 |
| missing-list-version-accepted | 70 | 2 |
| edit-skips-complete-get | 66 | 6 |
| preview-skips-complete-get | 70 | 2 |
| mandatory-native-artifact-check-not-run | 3 | 1 |

逐项复核本单元20路径、共享JSON预算/DB投影/两适配器/API协议/UI价格与照片/分类身份/行与批量写保护/完整读取/常驻烟测与驱动接线，以及原分类CAS、RecordForm和公开列表接缝。没有新增SDK方法、依赖、资源或存储分裂。简化检查保持一套预算与projector；UI标记只在响应生成，不写入产品或推进generation。文案把“预算证明列表性能”收紧到“HTTP返回预算”，明确无数据库内部读量/P95证明；核对计数分母、首轮失败和未完成门槛。

P3稳定操作、合法大媒体分阶段提交、登录草稿、历史审计、云并发/性能、test部署及真实20件发布恢复继续。尚不能称为整体修复完成，fullDeliveryReady=false。
