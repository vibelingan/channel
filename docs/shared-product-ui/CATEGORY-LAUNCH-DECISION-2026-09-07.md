# 分类上线决策：已基本确认，按有限范围实施

日期：2026-09-07。分支 fix/alibaba-sync-storage-wiring@60b051b。
2026-09-08 状态：客户已基本认可归类建议；本地实施见 [分类实施结果](CATEGORY-IMPLEMENTATION-2026-09-08.md)。
执行 Misc 291 / AI Gadgets 5 / Toys 6 的历史清单范围，56 件暂不处理。
下表 deferred 是“保持原状”，不是批准排除或隐藏。线上尚未应用。
下面 09-07 的客户消息/核查是历史记录，确认范围以本段和实施结果为准，无需再向客户重复提问。
本次仅只读云端及本地验证，未部署、未写线上商品/映射、未发布。
此文优先于此前“taxonomy 暂缓”以及先推进 09B 的排期。

## 1. 直接结论

不需要客户去 Alibaba 逐件补分类，也不需要重新全量同步。
原始详情中真实字段是 `alibaba_icbu_product_get_response.product.category_id`。
解析器取该字段（另兼容 cat_id），写入 sourceCategoryId；统一映射键是
`(provider=alibaba, sourceTaxonomy=alibaba:icbu, sourceCategoryId)`。

本轮重新分页读取 1081 个不同 products；其中 1074 个带 Alibaba source review，
这 1074 个的 sourceCategoryId 全部有值（缺失 0）。网站未分类 358 个，全部未发布。
这不是供应商未填类目，而是 **我们只配置了 5 条来源 ID → headphones 的规则，
余下 62 个来源 ID 没有官网规则**。网站 productFamily 是一级导航，不是 Alibaba 原字段。
当前四值是 headphones / ai-gadgets / toys / misc。旧 category= wired/office/bluetooth
是耳机兼容筛选字段，不是平台类目树；不把这些字段混用。

仅凭平台类目不能回答官网经营范围。例如来源 100001765 的 8 件商品有 4 件标题明确写 AI，
也有 4 件普通毛绒/录音玩具；来源 63708 有 10 件麦克风标题和 1 件装饰品标题。
后者是分类/标题不一致的待核查证据，不能据标题断言上游一定填错。
这些是明确例外，不以“每次同步 AI 猜标题”作为生产规则。

## 2. 给客户的消息（可直接发送）

> 官网分类接入已查明：Alibaba 商品都有平台类目，不需要您重新填写或逐件改商品。
> 我们建议保留官网现有四个主类，并在官网后台一次性配置批量映射：
> 1. 钟表、音箱/麦克风、风扇、灯具、小电器和数码配件归 Other Electronics & Toys。
> 2. 明确的 AI 互动玩具归 AI Gadgets；普通玩具归 Toys。
> 3. 工业电机、车辆/叉车、设计加工服务及非电子日用品暂不在官网展示，原数据保留为草稿。
> 请确认这三条是否符合经营范围；只需指出要调整的类别，不需要逐件操作。
> 按当前商品清单，这会处理 291 件 Other Electronics & Toys、5 件 AI Gadgets、
> 6 件 Toys，并保留 56 件不展示。数量是建议方案计算结果，不是已批准或已执行结果。
> 如果您已有完整分类表，可提供商品编号与官网主类的对照（Alibaba 商品 ID 最可靠；
> SKU 需先验证唯一性），我们批量匹配，不用重新录入。

客户必须决定的是“卖哪些、放哪个官网入口”，不是技术字段能否获取。
建议是基于现有标题的人工分组，不能冒充客户已确认事实或 Alibaba 官方类目名称。
如客户希望 56 件中的工业/非电子商品也展示，需指出这些组的目标主类，
或明确同意新增官网主类（后者是单独 schema/导航变更，不能私自塞入 Misc）。
客户没有提供确认前，本次不改变这些商品的经营归属。

## 3. 为什么不用店小秘内部分类自动代替

三套体系必须区分：

| 数据 | 来源与用途 | 本次是否可直接作为官网规则依据 |
|---|---|---|
| category_id | Alibaba 平台商品类目 ID | 可以；已经完整取得，推荐主路径 |
| group_id / 店铺产品分组 | 卖家在平台店铺创建的组织方式 | 可作为后续可选依据；本轮仅 1/3 原始样本有 group_id，不具备已验证全覆盖 |
| 店小秘分类 | 店小秘内部整理目录 | 官方说明仅在小秘页面展示，不影响平台店铺；不能假定会进入 Alibaba API |

本轮直接读取 3 个已存私有原始 product.get 对象：
- 002735aa…：product.category_id=201745901，并有 product.group_id=955939851；
- 002be3f4…、0045f566…：product.category_id=152801，没有 product.group_id。
这些是样本检查，不外推 1074 件全部 group_id 覆盖率；未查询该 group_id 的名称。
当前 normalizer 没有将 group_id 作为分类决策字段，不能宣称已经支持店铺分组映射。

[店小秘官方说明](https://help.dianxiaomi.com/faq/productFAQ/1885)：
店铺分组由平台后台创建；店小秘可以同步并批量指定。内部“店小秘分类”仅影响小秘页面。
若客户确实希望从店小秘维护对外分组，官方批量路径为：
产品 → 待发布/在线产品 → 选择具体店铺 → 勾选产品 → 快捷操作 → 全属性修改
→ 产品分组 → 同步分组 → 选择分组。
不要误用“移动分类”，那是店小秘内部分类；新建/改名店铺分组需在平台后台进行。
此流程据官方帮助核实，未在客户账号实际执行；**不是当前上线的前置要求**。
如选择这条可选路线，必须另外验证 group API 权限、完整覆盖、多组优先级和 adapter 支持后才能采用。

## 4. 确定的实现边界

1. 客户确认下面的有限规则和经营范围后，在我们一侧持久化来源 ID 映射；不改 Alibaba。
2. 普通来源类目复用默认映射；两类混合来源的 18 件按下面清单应用例外，另 1 件暂不处理，
   以后同来源的新商品进入待分类（不自动猜 AI、不自动放耳机）。
3. 已确认官网分类不被后续 Alibaba 同步覆盖；价格/内容等来源信息仍正常更新。
   来源类目变化另记待复核，不能静默移动已发布商品。
4. 新商品有已确认规则就归类为草稿；无规则/混合类目没有单品决定则留待分类。
   **无有效官网主类不得发布**，后端校验，不是仅 UI 禁用。
5. 用户最新指示是 56 件暂不处理，不实现 excluded 决策；不删源记录、不自动发布，
   也不写某个假 productFamily。若以后决定不经营某些商品，再明确业务范围。
6. 历史 358 件按确定 ID 在官网侧分批重分类，不重新拉取 product.get。
   应用只改未发布、版本未变、符合预览条件的项；保留人工非空分类，写审计/恢复进度。
   批量必须有专用受控动作，当前通用 products batchUpdate 明确禁止，不能绕过它直接 MCP 写库。
7. Ali 与 Excel 继续用同一 sourceCategoryMappings / 官网 productFamily 合同，
   但来源键带 provider/taxonomy 命名空间；不把 Alibaba 数字 ID 当作 Lazada/店小秘 ID。

已有：来源字段持久化、默认映射查询、草稿生成、非空官网分类不覆盖、基本发布必填校验。
09-08 已完成本地：规则键/冲突校验、有限单品决定、源改类提示和可恢复批量应用。
排除状态不在本轮授权内。线上部署/新鲜预览/回填验收仍待 CI/CD，不能据本地结果声称线上已完成。

下一步分类发布：**依赖收口与审查 → 提交与 CI → 合并 test 后统一 CI/CD →
Admin 新鲜预览与批量应用 → 线上重新计数验收**。
在分类决策及其闭环验收完成前不推进 09B，不因待分类队列完成就解除 P0。
分类解决也不代替正式详情/RFQ 等原有发布门槛。

## 5. 来源类目决策清单（待客户批准）

下表覆盖这 358 件的全部 62 个来源 ID。名称列是商品标题示例，不是官方类目名称。
deferred 表示本轮暂不处理；needs-review 表示混合类目不设置自动默认。
未列出的未来来源 ID 一律待分类；绝不以 excluded 或 headphones 兜底。

| 来源 category_id | 当前件数 | 建议默认决定 | 商品标题示例 |
|---|---:|---|---|
| 152801 | 185 | misc | Cat Cute Shape Sleep Training Color Wake up Light Temperature Display Kids Alarm Clock |
| 152805 | 56 | misc | W118 11 Inch for Men Black Decor Decorative for Living Room Cheap Mechanical Moving Gears Wall Clock |
| 100007155 | 13 | deferred（暂不处理） | Nema 23 24 25 Stepper Motor Driver 60 Series 1.8 Degree Multi-Size Mini Hybrid Stepping Motor |
| 63708 | 11 | needs-review（混合类目） | condenser microphone mobile phone computer live broadcast Karaoke wired recording microphone with bracket set foreign trade |
| 518 | 9 | misc | WS23 China Big Factory Mini Professional Tws Party Table Led Outdoor RGB Portable Waterproof Speaker |
| 100001765 | 8 | needs-review（混合类目） | AI Interactive Plush Toy Fortune Cat with LED Eyes Voice Chat Storytelling Kids Gift Wholesale ZCM-01 |
| 1458 | 6 | deferred（暂不处理） | Custom Industrial Design Mechanical Design Production Processing Service Product Design and Development Services |
| 100003264 | 3 | misc | Flip Induction Rubik's Cube Gravity Timer Small Countdown Kitchen Timer for Time Management for Kids Study |
| 100007153 | 3 | deferred（暂不处理） | High Speed Customizable Mini 12mm 12v 6500Rpm Dc Brush Motor for Electric Bicycle and Home Appliances Projector |
| 201340406 | 3 | misc | Vantilator Natural Air Low Noise Quiet Bladeless Tower Fan Smart Electric Cooling Fan Without Blade |
| 100004566 | 2 | deferred（暂不处理） | China Wholesale Cnc Machining Parts Services 3d Rapid Printing Custom Plastic Acrylic Abs Prototype Toy Model |
| 100004574 | 2 | deferred（暂不处理） | OEM Development of Doll Toy Design and Fabrication Services Custom Recording Services for Toy Production |
| 100010895 | 2 | misc | Hot Selling Promotion Mini Capsule Power Bank Fast Charging With Phone Holder 5000Mah for Iphone |
| 154102 | 2 | deferred（暂不处理） | Multifunctional Drain Folding Handle Fruit Fresh-keeping Storage Box with Lid Vegetable Drain Double-layer Fresh-keeping Box |
| 201467503 | 2 | misc | Personalised Fashionable Round Plastic Cosmetic Fold Portable Makeup Compact Pocket Mirror With Led Light |
| 201745302 | 2 | misc | Personalized Sublimation Custom Logo Printed Customised Gaming Rgb Mouse Pad Wireless Charger |
| 201775601 | 2 | misc | Recording Studio Sound Card Music Studio Equipment Sound Card for Recording Studio with Microphone |
| 617 | 2 | misc | Professional Salon High Speed Hair Dryer With AC Motor Powerful Mini Blower for Wholesale Ideal for Drying Hair |
| 708023 | 2 | deferred（暂不处理） | Custom Blanks Size Transfer Heat Press Neoprene Rubber Print Sublimation Gaming Office Mouse Pad |
| 100000157 | 1 | misc | Preservation and Sealing Machine Household Food Packaging Machine Food Extraction Vacuum Pump Compression Bag Baler |
| 100002897 | 1 | deferred（暂不处理） | 2022 BMW 5 Series 530Li M Sport Package Low Mileage 22k km Certified Pre-Owned Luxury Sedan Premium Interior & Dynamic Handling |
| 100003049 | 1 | deferred（暂不处理） | Print on Demand Pizza Cutting Tools Kitchen Accessories Wheel Stainless Steel Rotating Custom Pizza Cutter With Handle Lo |
| 100003288 | 1 | deferred（暂不处理） | Print on Demand Double Wall Stainless Steel Insulated Leak-proof Recyclable Travel Custom Gifts Logo Coffee Tumbler Cups |
| 100003291 | 1 | deferred（暂不处理） | Wedding Gifts Souvenirs Print on Demand Coated Metal Stainless Steel Double Wall Insulated Vacuum Cup Coffee Tumblers Tr |
| 100004267 | 1 | deferred（暂不处理） | Entrance Key Storage Ins Solid Wood Punching Wall Hook Door Creative Cute Wall-mounted Decoration |
| 100010893 | 1 | misc | Print on Demand Portable Multifunctional Custom 3 in 1 Usb Charging Cable Travel Kit Data Cable for Mobile Phones With Logo |
| 141905 | 1 | misc | Household Tower Extension Cord 8 AC Outlets 6 Way USB Ports Vertical Surge with Cable Power Strip |
| 151412 | 1 | deferred（暂不处理） | Household Transparent Light Luxury Living Room Large Bedroom Kitchen Bathroom Office Paper Basket Transparent Flower Bucket |
| 152212 | 1 | deferred（暂不处理） | Customized Logo Print on Demand Wooden Lid Plastic Tissue Box Paper Storage Box Home Car Gift Advertisement Custom Tissue Box |
| 15230312 | 1 | deferred（暂不处理） | 316 Stainless Steel Milk Pot Baby Complementary Food Pot Extra Thick Non-stick Pot Instant Noodle Pot Baby Cooking |
| 152405 | 1 | deferred（暂不处理） | Ladies Wallet Short Creative Fashion Girls Short Small Mini Coin Purse Custom Leather Pu Women Wallet |
| 152407 | 1 | deferred（暂不处理） | Nylon Durable Toiletry Bag Pouch Embroidery Zipper Cotton Makeup Cosmetic Bag Custom Logo With Zipper |
| 152802 | 1 | misc | Unique Gift Items Cube Clock Colorful Square Led Bedroom Luminous Electronic Reminder Custom Square Alarm Clock With Logo |
| 153801 | 1 | deferred（暂不处理） | Sunshade Canvas Triangle Sunshade Net Sunshade Cloth Triangle Sunshade Cloth Outdoor Awning Portable |
| 1710 | 1 | deferred（暂不处理） | Chinese Style Print on Demand Custom High Quality Personalized Bamboo Hand Ancient Style Transparent Long Handle Round Hend Fan |
| 200554009 | 1 | misc | New Portable Soda Streaming Machine 1L with CO2 Cylinder for Home/Bar Sparkling Water Fast Carbonation Energy Saving |
| 201219709 | 1 | deferred（暂不处理） | OEM Service Supplier Making Electronic Pcb & Pcba Board  Design Printed Circuits Board Assembly And Manufacture Assembly |
| 201331611 | 1 | deferred（暂不处理） | Picnic Mat Moisture-proof Mat Thickened Camping Beach Picnic Spring Outing Waterproof Portable Lawn Mat Floor Mat Outdoor Tent |
| 201334110 | 1 | misc | Mobile Phone Portable Small Quick Wireless Fast Charger 10W Custom Logo Personalized for Gift |
| 201335115 | 1 | misc | Automatic Smart Sensor Bug Zapper Electric Shock Killing Lamp Kills Mosquito Fly Trap |
| 201339713 | 1 | deferred（暂不处理） | Thickened Rice Bucket Sealed Household Insect-proof and Moisture-proof Rice Box Rice Storage Box Rice Tank Flour Storage Tank |
| 201348002 | 1 | misc | Dismountable Oxygen Bottle Portable Hydrogen Water Bottle Generator Machine Ionizer Glass Health Cup |
| 201395903 | 1 | deferred（暂不处理） | Custom Business Gift Items for Business Other Promotional & Corporate Gifts Events for Promotion and Marketing |
| 201452126 | 1 | toys | Print on Demand DIY Blank Puzzle Personalized Adult Kids Custom Puzzle Game Jigsaw Puzzles Gifts Souvenirs |
| 201464906 | 1 | deferred（暂不处理） | Disposable Cup Cup Picker Water Dispenser Water Cup Rack Wall Hanging Storage Kitchen Rack Paper Cup Holder Cup Holder |
| 201469005 | 1 | deferred（暂不处理） | Household High-end Floor Mirror Internet Celebrity Cream Style Fitting Mirror Girls Bedroom Simple Light Luxury Dressing Mirror |
| 201725301 | 1 | deferred（暂不处理） | Print on Demand Cat Comb Grooming Pet Hair Remove Brush Dog Slicker Brushes for Pets Long Short Hair Custom Logo Pet Brush |
| 201745801 | 1 | misc | Magnetic suction wireless collar clip microphone k9 trembles outdoor live video noise reduction monitor reverberation |
| 201768109 | 1 | deferred（暂不处理） | Print on Demand Unique Gadgets Personalized Hanging Mini Leather Custom Logo Double Side Printing Heart Leather Keychain |
| 201886409 | 1 | misc | Multifunctional Folding Outdoor Camping Light Long Battery Life Atmosphere Camping Outdoor Lighting Charging Tent Portable |
| 201888707 | 1 | toys | Custom Printed Patterns Mini Frisbeed Plastic Training Flying Discs Toy Set Customized Logo Kids OEM Print on Demand |
| 201890409 | 1 | misc | Solar Camping Light Outdoor Camping Light Tent Light Portable Mobile Stall Portable Folding Solar Light |
| 201930401 | 1 | misc | Custom Pattern Selling Reusable Rechargeable Usb Mini Hand Warmer 12000ma Digital Display Power Banks |
| 201933601 | 1 | misc | Redwingy Retro Wireless Lautsprecher Bluetooth 5.0 Stereo Music Player Desktop Wecker Vintage Form Tf Karte |
| 201951703 | 1 | misc | Custom Logo Multinational Universal Usb Type-c Wall Charger Foldable US EU UK Plug Fast Charging Travel Adapter |
| 201959001 | 1 | deferred（暂不处理） | Custom Souvenir Items Print on Demand Gifts Hustiement Unique Kitchen Gadgets Uv Printing Service Logo Bento Lunch Box |
| 202223007 | 1 | deferred（暂不处理） | 2-3 Ton Lithium Electric Forklift Truck Four-Wheel Hydraulic System Fast Charging & Low Noise Warehouse & Industrial Lifti |
| 202223009 | 1 | deferred（暂不处理） | 3-Ton Hydraulic Diesel Forklift Truck with Side Shift & 4-4.5m Lifting Height for Warehouse/Port Material Handling |
| 202241202 | 1 | deferred（暂不处理） | Print on Demand PU Leather Students Stationery Gift Advertising Pen Pouch Durable Office Fountain Pen Bag for Custom logo |
| 2601 | 1 | ai-gadgets | AI Robot Toy Smart Interactive Companion Robot for Kids Home Educational Gift |
| 5093005 | 1 | deferred（暂不处理） | Print on Demand Universal Souvenir Items Custom Printed Long Detachable Mobile Phone Case Lanyard Crossbody With Phone Patch |
| 66010102 | 1 | misc | Portable Handheld Laser Hair Removal Instrument for Painless Permanent Hair Removal with Cooling and Freezing Point Technology |

## 6. 两个混合类目的存量清单（18 件执行，1 件暂不处理）

按稳定官网 product ID 列示，仅用于本次私有 Admin 决策清单；正式持久化还须校验
其 Alibaba source owner / product ID 与版本，不能用标题作为写入匹配条件。
四件 AI 识别来自原始标题，经本轮客户基本确认后纳入明确 ID 清单，不是运行时关键词分类器。

| 官网 product ID | 来源类目 | 建议单品决定 | 当前标题 |
|---|---|---|---|
| 051a9011-8e4c-408f-acc1-d08e00a10dad | 63708 | misc | condenser microphone mobile phone computer live broadcast Karaoke wired recording microphone with bracket set foreign trade |
| 0f5f4aa4-7dd1-42d6-aafd-1a32aaae18a4 | 63708 | deferred（暂不处理） | Genuine Jade Sanrio Cinnamon Dog Pacha Dog Ornament Crystal Ball Birthday Gift for Girl Big-Eared Dog |
| 20db9073-60fa-443e-a6d3-7e7edc75f0e6 | 63708 | misc | private model wireless collar microphone radio noise reduction recording broadcast small microphone shooting collar microphone |
| 22a0bc9b-2eaa-4f6b-ab6e-82a1053df777 | 100001765 | ai-gadgets | AI Interactive Plush Toy Fortune Cat with LED Eyes Voice Chat Storytelling Kids Gift Wholesale ZCM-01 |
| 258394ec-d04d-4777-a0ab-fa1b14ba4375 | 100001765 | toys | Print on Demand Professional Make Your Own Custom Plush Toy Character Plushie Recording Dolls Stuffed Animals |
| 28f0d1e6-07ee-4953-a99a-eb64054bd77c | 100001765 | ai-gadgets | AI Interactive Plush Toy Smart Emotional Companion Stuffed Animal with LED Eyes Voice Chat Storytelling Kids Gift XPZ-01 |
| 41a5a18e-80c5-433c-a0e6-efa9d08658b3 | 63708 | misc | Adjustable Dynamic Microphone for Studio Recording for Podcasting and Vocal Capture |
| 52786afa-6d3e-4f37-a061-92f93574f15f | 63708 | misc | Wired Condenser Microphone Set with Type C Sound Card Noise Cancelling Feature for Smart Phone Live Streaming Karaoke Recording |
| 55d056ed-563c-49f7-ae83-116be5036442 | 100001765 | toys | Dress-Up Doll Stuffed Animal Toys Plush Birthday Gift for Children Mini Plush Toy Plush Stuffed Animal Toys |
| 7013a1dc-0810-4df3-a98b-660d1b2ba8dc | 63708 | misc | Microphone computer desktop microphone live streaming host home chicken eating voice chat Game LIVE recording YY voice wholesale |
| 70bd6aaa-796a-460a-a36d-33c2f0490f49 | 100001765 | ai-gadgets | AI Interactive Plush Toy Sitting Posture Emotional Companion with LED Eyes Voice Chat Storytelling Kids Gift Wholesale ZZ-01 |
| 87c936f3-54fb-43b3-abd2-806fedfcffb6 | 63708 | misc | USB Hold Conference Chat Computer Microphone Microphone Game Voice Notebook Wired Condenser Microphone |
| 89f59908-9302-45cc-aa92-18752d4c3ed4 | 100001765 | ai-gadgets | AI Emotional Companion Plush Toy XiaoPa Home Edition Emotion Recognition Sleep Aid Memory Enabled Kids Gift Wholesale XP-2.4G |
| 8d8611ca-8c6a-4731-a0db-080977d73283 | 63708 | misc | computer live broadcast noise reduction recording e-sports RGB capacitor USB microphone cross-border pure English |
| 9384703e-d09f-42f8-aa97-8dfbcaf87e04 | 100001765 | toys | Kawaii Monchhichis Custom Plush Bear Toy 20cm Soft Stuffed Animal Unisex Kids Toy and Valentine's Day Gift |
| a5ab40df-d3ff-4baa-ad3a-1aacc4615448 | 63708 | misc | cross-border computer recording sound card integrated live broadcast device USB live broadcast microphone microphone |
| b8677602-2935-417d-a8fa-64fb377b9835 | 63708 | misc | USB colorful computer microphone game competitive mobile phone live singing recording noise reduction condenser microphone set |
| cfb80022-696c-478d-aaa4-d10e5c1c1d3a | 100001765 | toys | Valentine's Day Gift Custom Teddy Bear Cloth Doll Cute Kawaii Stuffed Animal Toy for Kids Height 11cm-30cm |
| f514ba21-1fe0-4ed4-a729-9f85f6bf9a31 | 63708 | misc | Dynamic Microphone Live Microphone Professional Recording Karaoke Conference Mobile Computer Game Sound Card Microphone Full Set |

## 7. 09-07 历史核验证据与边界（非 09-08 结果）

- 云端只读 products 分页 request IDs：a7683640-ddba-4f4a-92ba-f213799931a7、
  e74564d5-27cd-4044-a67e-021b873ce534。非事务快照，实际写入前仍须版本预检。
- 3 个原始对象只读取分类字段及分组字段，不在文档保存完整原始响应或签名地址。
- 本地现有回归：shared 分类/批准 21 项、Alibaba linking 11 项、admin handler 160 项，
  合计 192 项通过，无失败、无跳过。证明已有路径；不冒充尚未实现的批量/排除闭环验收。
- 当前 Node 25 的本地测试沿用 --no-experimental-webstorage；未改远端 runtime。
- 本轮改动限于决策/优先级文档；没有部署、数据回填、商品发布或跨分支操作。
