# 分类修复与映射验收计划（2026-09-07）

2026-09-08 执行覆盖：客户已基本确认归类建议，见 [本轮实现与验收](CATEGORY-IMPLEMENTATION-2026-09-08.md)。
30 条规则 + 18 件混合类目例外用于已确认范围；56 件暂不处理，不写 excluded。
CAT-02/03/04 的有限分类闭环已本地实现；不含通用排除管理、任意规则历史回滚或新分类树。
批次失败采取事务回滚和幂等续跑；已完成分类如需业务改类，走现有单品编辑，不声称有批量撤销按钮。
下文保留原调查和更广泛设计背景；与本段不一致时以本轮实施文档为准。线上未改。

**最新结论/客户操作以 [分类上线决策](CATEGORY-LAUNCH-DECISION-2026-09-07.md) 为准。**
分类为 P0，不再先推进 09B；原始 category_id 已确认，1074 件来源 ID 缺失为 0。
客户无需逐件改 Alibaba；现已确认先处理建议中的 302 件，其余 56 件本次不处理。
下文 CAT-01 验收为已完成历史记录，不能用待分类队列代替 CAT-02..04 的主要闭环。

状态：CAT-01 本地队列、后端筛选及真实落盘/浏览器编辑已验证；云端只读核对完成。未部署、未改线上商品分类、未发布。
本轮用户明确要求优先解决分类，替代此前“taxonomy 暂缓”的排期，不替代正式详情/RFQ 发布门槛。

## 1. 当前事实（本轮重新查询）

环境 diversity-123-d9grnqfux221323bb（supplychainsai.com），NoSQL tnt-2jvggnev2。
products 按 _id 升序分页 1000 + 81，合计 1081 个不同商品；非事务审计快照，不作为批量写入前置条件。
按现有 productFamilyForDoc 兼容规则：Headphones 720、Toys 3、AI Gadgets 0、Misc 0、未分类 358。
其中 Alibaba 来源 1074：716 Headphones，358 未分类；另 7 个旧商品是 4 Headphones + 3 Toys。
358 个未分类商品全部 published=false，有 62 个不同的来源 category_id。
另用与待分类后端相同的原生查询独立 count，返回 358（request ID：
ccf7adf5-cea1-4816-a980-250e085e8bfd）。
因此后台只看 Headphones 不是同步漏拉；不过不能说线上“完全只有耳机”，数据库仍有 3 个 Toys。
若用户的 Toys 标签显示 0，应核对搜索/过滤器/旧页面部署版本，不把 UI 截图当作数据库总数。

sourceCategoryMappings 目前恰好 5 条，全部指向 headphones：
201745901、202063712、202063410、202061615、202055012。
无其它主类规则。来源分类不是 wired/office/bluetooth。

## 2. 字段的真实含义

| 层次 | 当前字段 | 意义 |
|---|---|---|
| 官网一级分组 | products.productFamily | 单个商品属于哪个上层集合；值为 headphones / ai-gadgets / toys / misc |
| 旧耳机筛选 | products.category | wired / office / bluetooth，只适用于耳机，不是全站通用树 |
| 来源证据 | alibabaSourceReview.sourceCategoryId / source observations | Alibaba 原始类目 ID，保留，不覆盖 |
| 跨来源规则 | sourceCategoryMappings | provider + taxonomy + sourceCategoryId 到官网主类和可选耳机子类 |
| 展示待办 | needsClassification 查询 / unclassified URL | 仅后台查询状态，绝不持久化为 productFamily |

productFamily 是用户理解的 superset 的成员字段；例如商品的 productFamily=headphones 代表这个商品属于耳机大类。
它不是在每个商品里存整棵分类树。保留字段名避免无价值迁移，界面说明其为官网分类。
现在没有“任意主类下可创建任意子类”的通用树。若需要 Clocks/Fans/Lighting 等二级分类，应独立增加
websiteCategoryId + 分类注册表/父子约束，而不是把标签写进旧 category enum。
客户暂未决定是否新增这些导航；本轮不凭空创建，也不丢来源字段。

## 3. 修复顺序与验收

### CAT-01 — 待分类可见且能逐项归类（本轮）

- 复用 CollectionView / ProductFamilyTab / Select / RecordForm，不新建第二套后台。
- All 后新增 Needs classification (全局数量)；手机同一 Select 提供入口。
- admin list 新增 needsClassification:boolean，必须用于 products，不能同时指定主类。
- DB/本地 adapter 在 count、sort、pagination 前筛选，不能只过滤当前 20 行。
- URL 可刷新/回退；搜索及 OR 条件仍与队列 AND 组合；切换时清选择和页码。
- 非法 query、匿名请求、将 unclassified 写入商品都拒绝。
- 编辑现有 Product Family 走现有真实 admin update / saveCatalogProduct；保存不改变 published。
- 旧 category=office 等且 family 缺失仍属于耳机；显式空/无效 family 不触发旧值回退。
- 数量为未分类总数，不等同“新到货/未读”；原 New 标记语义不变。
- 未分类可能包含人为损坏的旧数据，不自动把它们当新商品或重新发布。
- 当前 NoSQL family/category 字段以注册表的标量字符串合同为前提；原生 $in/$nin 对损坏数组有数组成员语义，
  批量迁移需做字段类型审计，不把该队列冒充所有损坏数据的修复工具。

视觉规范：工业工具型、沿用现有 Admin 表格与左侧导航。
字体沿用 Poppins/Inter；色彩沿用 ink #0f172a、muted #64748b、surface #ffffff、边框 slate-200。
是既有设计系统扩展，不按通用技能建议更换字体、色系或打破现有网格。

### CAT-02 — 映射建议、逐项例外、排除、影响预览（下一步，不声称已实现）

已有 Import Categories 只管理规则，不是“保存规则就批量重分类”的操作台。
在其基础上增加 category coverage（按来源键分组的数量、样本、现有主类、规则状态）与 preview。
同一 sourceCategoryId 可能混合不同产品；只看一个标题不够，也不从标题直接执行自动写入。
优先复核大组：152801 的 185 件、152805 的 56 件、152802 的 1 件，样本以钟表为主，共 242 件；
这只是审核优先级，不是已批准规则。

分类决策需要三种状态：mapped / needs-review / excluded。
excluded 意味着客户不想展示（例如车辆、工业服务），仍保留来源和草稿，不删除或重复同步。
逐商品 override 优先于类目默认规则；记录操作者、原因、版本、时间、来源分类版本。
当前已有人工非空分类一律保护，不把无 provenance 的旧值冒充自动结果。
建议优先级：explicit product decision > reviewed source rule > legacy-compatible existing classification > needs-review。
混合类目支持逐项决定，不要求客户先清理整个 Alibaba 店铺才能推进网站。

preview 返回影响数量与分页例子，区分将更新/人工保护/已发布保护/源已变更/缺证据/冲突；
同时带规则版本、商品版本、来源快照摘要及有效期。不能直接沿用普通 batchUpdate 无条件覆盖。
映射键唯一性与空来源 ID 必须校验；当前通用 CRUD 不提供这些完整业务保证，不能宣称已有闭环。

### CAT-03 — 已确认规则的可恢复批量应用（CAT-02 后）

admin-only 动作；分批 cursor（_id 总排序）+ 服务端逐条 CAS/事务 + operationId 幂等。
事务中重读产品/source revision/映射决策，只更新未分类且未发布的候选；
不覆盖新人工编辑，不改来源证据，不改公开快照，不自动发布。
每条 applied/skipped/conflict/failed 可追踪，失败只重试未完成部分；回滚仅恢复仍匹配本操作版本的项。
来源已存在，所以是本地镜像重分类，不重新请求全部 Alibaba 商品。
重分类是 identity/publication 边界的一部分，必须与现有 catalog approval 的版本检查联动。

### CAT-04 — 后续增量不会反复周转

Ali/Excel 均读取同一规则决策服务。首次同步有已批准映射则填入草稿主类；无规则进入待分类。
来源 category_id 发生变化：标记需要复核，保留人工分类和已批准公开快照，禁止静默挪动已发布商品。
规则版本变化：产生可预览的重新归类任务，不在普通列表 GET 或后台打开时触发写入。
分类审核、内容审核、发布是三件事；标记已看过不消除待分类。

## 4. 客户需要决定的最小事项

1. 哪些来源商品在官网经营范围内：钟表、家居用品、电机/叉车/车辆/设计服务是否排除？
2. 现有 Other Electronics & Toys 能否覆盖钟表、风扇、灯具？还是需要新增官网主类？
3. AI 玩具放 AI Gadgets 还是 Toys？V1 每件只能选一个主类，跨类曝光应独立标签，不复制商品。
4. 是否需要公开二级导航 Clocks/Fans/Lighting？若不需要，先完成主类即可；来源细分类照常保留。

## 5. 未分类来源分组（只读证据，不是建议已批准）

没有拿到官方分类名称时，只显示 ID 和原始商品标题，不伪造类目名称。
所有下列组网站主类待决定，样本最多三条；优先审查数量大的组，再处理混合组和经营范围外组。

| 来源 category_id | 未分类草稿数 | 原始标题样本 |
|---|---:|---|
| 152801 | 185 | Cat Cute Shape Sleep Training Color Wake up Light Temperature Display Kids Alarm Clock<br>T123 Tabletop for Gear Desk China Kids Children Mechanical Soccer Football Alarm Table Cartoon Clock<br>T535A Manufacturer Mini Table Timer Day Room Desk Wake up Table Light Led Alarm Desk Clock Digital |
| 152805 | 56 | W118 11 Inch for Men Black Decor Decorative for Living Room Cheap Mechanical Moving Gears Wall Clock<br>W110 10 Inch Chinese Modern Decorative Nordic Decor Home Analog Movement Relojes Silent Fancy Wall Clock<br>Creativity Home Children's Room Living Room Wooden 3D Three Dimensional Cute Bear Cartoon Decor Wall Clock |
| 100007155 | 13 | Nema 23 24 25 Stepper Motor Driver 60 Series 1.8 Degree Multi-Size Mini Hybrid Stepping Motor<br>Permanent Magnet 4.0A Servo Stepper Motor Nema 23 High Torque 1.3N.m Encoder 2 Phase Cl57 Drive Step Motor<br>Good Quality 2 Phase 2200mn.m Low Rpm High Torque Dc Nema 23 Stepper Motor 57mm Frame Torque Shaft Square Printer |
| 63708 | 11 | condenser microphone mobile phone computer live broadcast Karaoke wired recording microphone with bracket set foreign trade<br>Genuine Jade Sanrio Cinnamon Dog Pacha Dog Ornament Crystal Ball Birthday Gift for Girl Big-Eared Dog<br>private model wireless collar microphone radio noise reduction recording broadcast small microphone shooting collar microphone |
| 518 | 9 | WS23 China Big Factory Mini Professional Tws Party Table Led Outdoor RGB Portable Waterproof Speaker<br>CS1 China Pa Home Active Mic Bass Outdoor With Subwoofer Audio Computer Powered Wireless Speaker<br>WS20 Original Small Marine Portable Mini Water Proof Outdoor Shower Ipx7 Wireless Waterproof Speaker |
| 100001765 | 8 | AI Interactive Plush Toy Fortune Cat with LED Eyes Voice Chat Storytelling Kids Gift Wholesale ZCM-01<br>Print on Demand Professional Make Your Own Custom Plush Toy Character Plushie Recording Dolls Stuffed Animals<br>AI Interactive Plush Toy Smart Emotional Companion Stuffed Animal with LED Eyes Voice Chat Storytelling Kids Gift XPZ-01 |
| 1458 | 6 | Custom Industrial Design Mechanical Design Production Processing Service Product Design and Development Services<br>Oem Best Price Product Engineering 3D Drawing Industrial Design and Development Consultancy Service<br>OEM Factory Custom Design and Develop Headphone Moulds Unique Product Features and Development |
| 100003264 | 3 | Flip Induction Rubik's Cube Gravity Timer Small Countdown Kitchen Timer for Time Management for Kids Study<br>Rubik's Square Mini Alarm Clock Multi Function Digital Gravity Sensing Flip Timer 60 Minute Kitchen Timers<br>Decompression Kitchen Digital Rotary Switching Timing Display Clock With Lapse Timer for Kids Countdown |
| 100007153 | 3 | High Speed Customizable Mini 12mm 12v 6500Rpm Dc Brush Motor for Electric Bicycle and Home Appliances Projector<br>High Torque Gearbox Electric 12v Micro Dc Motor 6V 12 Volt 24V 12V Micro Spur Brushed Dc Gear Motor<br>Wholesale Micro Round 32mm Diameter Mini Dc 3V 5V 9V 12V 24V Electric Motor for Cd Dvd Vcr Player |
| 201340406 | 3 | Vantilator Natural Air Low Noise Quiet Bladeless Tower Fan Smart Electric Cooling Fan Without Blade<br>Electric Portable Table Fan High Speed Air Ventilation Wind Air Circulation Fan Cooling Fans With Remote Control<br>Room Air Circulator Remote Control Air Conditioning Remote Control Timing Air Circulator Pedestal Electric Stand Fan |
| 617 | 2 | Professional Salon High Speed Hair Dryer With AC Motor Powerful Mini Blower for Wholesale Ideal for Drying Hair<br>AC Motor Professional Salon High-Speed Hair Dryer Powerful Mini Blower for Wholesale Exceptional for Drying Hair |
| 154102 | 2 | Multifunctional Drain Folding Handle Fruit Fresh-keeping Storage Box with Lid Vegetable Drain Double-layer Fresh-keeping Box<br>Folding Silicone Lunch Box Portable Crisper Microwave Oven Bento Box Plastic Square Lunch Box Refrigerator Storage Box Wholesale |
| 708023 | 2 | Custom Blanks Size Transfer Heat Press Neoprene Rubber Print Sublimation Gaming Office Mouse Pad<br>Custom Blanks Size Transfer Heat Press Neoprene Rubber Print Sublimation Gaming Office Mouse Pad |
| 100004566 | 2 | China Wholesale Cnc Machining Parts Services 3d Rapid Printing Custom Plastic Acrylic Abs Prototype Toy Model<br>Factory Precision Low Price Oem Custom Stainless Steel Aluminum Titanium Cnc Custom Machined Parts |
| 100004574 | 2 | OEM Development of Doll Toy Design and Fabrication Services Custom Recording Services for Toy Production<br>3D Drawing Industrial Product Design and Development Kid Toy Fabrication Services |
| 100010895 | 2 | Hot Selling Promotion Mini Capsule Power Bank Fast Charging With Phone Holder 5000Mah for Iphone<br>OEM Custom Logo Gift Portable Charger Battery Slim Powerbank 10000 Mah Graphic Designers Service |
| 201467503 | 2 | Personalised Fashionable Round Plastic Cosmetic Fold Portable Makeup Compact Pocket Mirror With Led Light<br>Cosmetics Led Vanity Adjustable 3 Colors Light 360 Degree Rotation Makeup Table Folding HD Mirror |
| 201745302 | 2 | Personalized Sublimation Custom Logo Printed Customised Gaming Rgb Mouse Pad Wireless Charger<br>Big Size Waterproof Keyboard Custom Personalized Logo RGB Mouse Pads Xxl Anime Pad Gaming Mat |
| 201775601 | 2 | Recording Studio Sound Card Music Studio Equipment Sound Card for Recording Studio with Microphone<br>Sound Card Set V8 Sound Card Podcast Cast Mic Karaoke Kit Usb Brand With High Quality Recording Studio Condenser Microphone |
| 1710 | 1 | Chinese Style Print on Demand Custom High Quality Personalized Bamboo Hand Ancient Style Transparent Long Handle Round Hend Fan |
| 2601 | 1 | AI Robot Toy Smart Interactive Companion Robot for Kids Home Educational Gift |
| 141905 | 1 | Household Tower Extension Cord 8 AC Outlets 6 Way USB Ports Vertical Surge with Cable Power Strip |
| 151412 | 1 | Household Transparent Light Luxury Living Room Large Bedroom Kitchen Bathroom Office Paper Basket Transparent Flower Bucket |
| 152212 | 1 | Customized Logo Print on Demand Wooden Lid Plastic Tissue Box Paper Storage Box Home Car Gift Advertisement Custom Tissue Box |
| 152405 | 1 | Ladies Wallet Short Creative Fashion Girls Short Small Mini Coin Purse Custom Leather Pu Women Wallet |
| 152407 | 1 | Nylon Durable Toiletry Bag Pouch Embroidery Zipper Cotton Makeup Cosmetic Bag Custom Logo With Zipper |
| 152802 | 1 | Unique Gift Items Cube Clock Colorful Square Led Bedroom Luminous Electronic Reminder Custom Square Alarm Clock With Logo |
| 153801 | 1 | Sunshade Canvas Triangle Sunshade Net Sunshade Cloth Triangle Sunshade Cloth Outdoor Awning Portable |
| 5093005 | 1 | Print on Demand Universal Souvenir Items Custom Printed Long Detachable Mobile Phone Case Lanyard Crossbody With Phone Patch |
| 15230312 | 1 | 316 Stainless Steel Milk Pot Baby Complementary Food Pot Extra Thick Non-stick Pot Instant Noodle Pot Baby Cooking |
| 66010102 | 1 | Portable Handheld Laser Hair Removal Instrument for Painless Permanent Hair Removal with Cooling and Freezing Point Technology |
| 100000157 | 1 | Preservation and Sealing Machine Household Food Packaging Machine Food Extraction Vacuum Pump Compression Bag Baler |
| 100002897 | 1 | 2022 BMW 5 Series 530Li M Sport Package Low Mileage 22k km Certified Pre-Owned Luxury Sedan Premium Interior & Dynamic Handling |
| 100003049 | 1 | Print on Demand Pizza Cutting Tools Kitchen Accessories Wheel Stainless Steel Rotating Custom Pizza Cutter With Handle Lo |
| 100003288 | 1 | Print on Demand Double Wall Stainless Steel Insulated Leak-proof Recyclable Travel Custom Gifts Logo Coffee Tumbler Cups |
| 100003291 | 1 | Wedding Gifts Souvenirs Print on Demand Coated Metal Stainless Steel Double Wall Insulated Vacuum Cup Coffee Tumblers Tr |
| 100004267 | 1 | Entrance Key Storage Ins Solid Wood Punching Wall Hook Door Creative Cute Wall-mounted Decoration |
| 100010893 | 1 | Print on Demand Portable Multifunctional Custom 3 in 1 Usb Charging Cable Travel Kit Data Cable for Mobile Phones With Logo |
| 200554009 | 1 | New Portable Soda Streaming Machine 1L with CO2 Cylinder for Home/Bar Sparkling Water Fast Carbonation Energy Saving |
| 201219709 | 1 | OEM Service Supplier Making Electronic Pcb & Pcba Board  Design Printed Circuits Board Assembly And Manufacture Assembly |
| 201331611 | 1 | Picnic Mat Moisture-proof Mat Thickened Camping Beach Picnic Spring Outing Waterproof Portable Lawn Mat Floor Mat Outdoor Tent |
| 201334110 | 1 | Mobile Phone Portable Small Quick Wireless Fast Charger 10W Custom Logo Personalized for Gift |
| 201335115 | 1 | Automatic Smart Sensor Bug Zapper Electric Shock Killing Lamp Kills Mosquito Fly Trap |
| 201339713 | 1 | Thickened Rice Bucket Sealed Household Insect-proof and Moisture-proof Rice Box Rice Storage Box Rice Tank Flour Storage Tank |
| 201348002 | 1 | Dismountable Oxygen Bottle Portable Hydrogen Water Bottle Generator Machine Ionizer Glass Health Cup |
| 201395903 | 1 | Custom Business Gift Items for Business Other Promotional & Corporate Gifts Events for Promotion and Marketing |
| 201452126 | 1 | Print on Demand DIY Blank Puzzle Personalized Adult Kids Custom Puzzle Game Jigsaw Puzzles Gifts Souvenirs |
| 201464906 | 1 | Disposable Cup Cup Picker Water Dispenser Water Cup Rack Wall Hanging Storage Kitchen Rack Paper Cup Holder Cup Holder |
| 201469005 | 1 | Household High-end Floor Mirror Internet Celebrity Cream Style Fitting Mirror Girls Bedroom Simple Light Luxury Dressing Mirror |
| 201725301 | 1 | Print on Demand Cat Comb Grooming Pet Hair Remove Brush Dog Slicker Brushes for Pets Long Short Hair Custom Logo Pet Brush |
| 201745801 | 1 | Magnetic suction wireless collar clip microphone k9 trembles outdoor live video noise reduction monitor reverberation |
| 201768109 | 1 | Print on Demand Unique Gadgets Personalized Hanging Mini Leather Custom Logo Double Side Printing Heart Leather Keychain |
| 201886409 | 1 | Multifunctional Folding Outdoor Camping Light Long Battery Life Atmosphere Camping Outdoor Lighting Charging Tent Portable |
| 201888707 | 1 | Custom Printed Patterns Mini Frisbeed Plastic Training Flying Discs Toy Set Customized Logo Kids OEM Print on Demand |
| 201890409 | 1 | Solar Camping Light Outdoor Camping Light Tent Light Portable Mobile Stall Portable Folding Solar Light |
| 201930401 | 1 | Custom Pattern Selling Reusable Rechargeable Usb Mini Hand Warmer 12000ma Digital Display Power Banks |
| 201933601 | 1 | Redwingy Retro Wireless Lautsprecher Bluetooth 5.0 Stereo Music Player Desktop Wecker Vintage Form Tf Karte |
| 201951703 | 1 | Custom Logo Multinational Universal Usb Type-c Wall Charger Foldable US EU UK Plug Fast Charging Travel Adapter |
| 201959001 | 1 | Custom Souvenir Items Print on Demand Gifts Hustiement Unique Kitchen Gadgets Uv Printing Service Logo Bento Lunch Box |
| 202223007 | 1 | 2-3 Ton Lithium Electric Forklift Truck Four-Wheel Hydraulic System Fast Charging & Low Noise Warehouse & Industrial Lifti |
| 202223009 | 1 | 3-Ton Hydraulic Diesel Forklift Truck with Side Shift & 4-4.5m Lifting Height for Warehouse/Port Material Handling |
| 202241202 | 1 | Print on Demand PU Leather Students Stationery Gift Advertising Pen Pouch Durable Office Fountain Pen Bag for Custom logo |

## 6. 发布边界

本次没有修改云端代码/资源/数据。云端只做指定实例的投影读取及 count。
按用户要求，仅通过分支提交、CI、合并 test、同版本 CI/CD 发布。先完成本地业务闭环，不能靠先部署再查漏。
CAT-01 可独立于买家 RFQ 验证；CAT-02..04 必须在批量重分类/自动应用开启前完成。
旧 CUI-09B.2/09C/09D 待办保留，分类插入不意味着那些功能已经完成。

## 7. 本轮验证与剩余边界

- 本地相关回归：shared 36、db 66、admin 207、site 330、local-server 83，合计 722，通过且无跳过。
- Chromium：后台桌面/手机/URL 状态 3 项；临时数据库 seed 1 项；真实登录及分类保存、旧商品生命周期、旧耳机迁类 3 项通过。
- 实际流程：创建无主类草稿 → 浏览器正常登录 → 待分类搜索 → 编辑为 misc → 队列移除 → Misc 标签出现 → API 重读仍未发布。
- JsonFileAdapter 另测关闭/重新打开后分类仍在且 published=false；不是浏览器内存状态。
- 全仓 typecheck、lint、站点 production build、CloudBase SDK contract verification、git diff --check 通过。
- 本机 Node 25.6.1 测试使用 --no-experimental-webstorage；没有改远端 runtime 或应用依赖。
- 线上仅只读：相同原生筛选 + alibabaReviewPending/createdAt/_id 稳定排序成功返回 total=358，request 0c1a7e21-6264-4754-9618-df88ee1fc7a3。
- SDK 核对：无 Context7；CloudBase 官方知识库检索到了 nin，但 readDoc 路由返回 404 HTML，未当成有效方法文档。
  改以已安装 wx-server-sdk 4.0.2 的命令运行时/序列化检查、仓库 SDK gate 和上述真实只读查询补证；未增加手写 SDK 方法。
- 依 CloudBase review 规则检查：浏览器不直接访问特权数据库；沿用当前服务端认证/角色/集合可读性校验，无权限规则变化、新集合或批量写动作。
- 初次浏览器尝试误用询价专用 4328（没有 Products 菜单）；在独立完整后台服务重跑通过。另修复测试登录尚未完成就跳页的等待问题。
  这是测试环境/步骤问题，不曾绕过真实登录；没有把失败测试跳过。
- 截图（本地临时测试商品，并非线上数据）：
  output/playwright/category-queue-desktop.png、output/playwright/category-queue-mobile.png。
  已逐张检查，手机使用现有 Select，表格仍使用现有横向滚动容器。
- 独立验收 DB 随 runner 清理；临时浏览器测试站点已停止；原 4328 询价预览未停止。

云端新 admin action/SDK adapter 整体验收仍待 CI/CD；管理 MCP 的 read-only count 不能冒充新版本函数已部署通过。
批量规则应用、人工 override 存储、excluded 决策与来源改类冲突提醒仍是 CAT-02..04，未在本轮虚报完成。
