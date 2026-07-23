export interface ReviewedBomRow {
  sourceCategory: string;
  sourceDescription: string;
  category: string;
  description: string;
  cost: number;
}

export interface ReviewedTeardownSource {
  slug: string;
  nonBomSha256: string;
  rows: ReviewedBomRow[];
}

/**
 * Human-reviewed snapshot of the three client BOM tables in
 * channel-oem-review/extracted/02-teardown.txt. The external source is not part
 * of this repository, so automated tests validate production and rendered DOM
 * against this tracked snapshot; the digest below is provenance for re-audit.
 *
 * Source SHA-256: 6a06040b079ff8df6f4190a3f025ab7148b4a59a01a5738beccf3df89e522414
 */
export const TEARDOWN_BOM_SOURCE_SHA256 =
  '6a06040b079ff8df6f4190a3f025ab7148b4a59a01a5738beccf3df89e522414';

export const teardownBomSource: ReviewedTeardownSource[] = [
  {
    slug: 'oladance-ows-pro',
    nonBomSha256: 'a23bfaf54f779f67600452789895f5cb87585f8bcd9d2bdfe674aeaab7b3a4b8',
    rows: [
      {
        sourceCategory: '塑膠機構與外殼',
        sourceDescription:
          'PC/ABS 腔體、8 層陶瓷塗層加工、鈦合金記憶金屬骨架、醫療級 LSR 液態矽膠二次包覆射出',
        category: 'Plastic Structure & Shell',
        description:
          'PC/ABS cavity, 8-layer ceramic coating, titanium-alloy memory-metal skeleton, medical-grade LSR overmolding',
        cost: 8.5,
      },
      {
        sourceCategory: 'PCBA 與電子元件',
        sourceDescription:
          '恆玄 BES2600YP 藍牙 SoC、艾為 AW86862 壓感 IC、6x MEMS 麥克風陣列、獨立音訊功放模組、中微 MCU',
        category: 'PCBA & Electronic Components',
        description:
          'Bestechnic BES2600YP Bluetooth SoC, Awinic AW86862 pressure-sensing IC, 6x MEMS microphone array, independent audio amplifier module, Cmsemicon MCU',
        cost: 15.2,
      },
      {
        sourceCategory: '聲學單體與腔體',
        sourceDescription: '23x10mm 客製化高精度雙層動圈單體 (左右耳成對)、金屬防塵網與調音濾網',
        category: 'Acoustic Driver & Chamber',
        description:
          'Paired 23x10mm custom high-precision dual-layer dynamic drivers, metal dust mesh and acoustic tuning filter',
        cost: 6.5,
      },
      {
        sourceCategory: '電池與電源管理',
        sourceDescription:
          '微宙 150mAh 鋼殼圓柱電池 (x2)、恆泰 1150mAh 鋰聚合物電池 (充電盒)、思遠 SY8809 電源管理 IC',
        category: 'Battery & Power Management',
        description:
          '2x MBT 150mAh steel-shell cylindrical batteries, Hengtai 1150mAh Li-polymer charging-case battery, Siyuan SY8809 power-management IC',
        cost: 4.8,
      },
      {
        sourceCategory: '包裝與附屬配件',
        sourceDescription: '高磅數天地蓋硬盒包裝、Type-C 充電線、防偽保固卡與說明書',
        category: 'Packaging & Accessories',
        description:
          'High-grade rigid lid-and-base box, Type-C charging cable, anti-counterfeit warranty card and manual',
        cost: 2,
      },
      {
        sourceCategory: '組裝與自動化測試',
        sourceDescription:
          'SMT 表面粘著、聲學微型消音箱配對測試、RF 天線射頻校準、液態點膠密封與 IPX4 防水氣密測試',
        category: 'Assembly & Automated Testing',
        description:
          'SMT, miniature anechoic-chamber pairing test, RF antenna calibration, liquid adhesive sealing and IPX4 airtightness test',
        cost: 3.5,
      },
      {
        sourceCategory: '模具攤提與治具',
        sourceDescription:
          '塑膠射出鋼模、LSR 專用冷流道矽膠模具、精密 CNC 測試治具 (以 10,000 套作為攤提基準)',
        category: 'Tooling Amortization & Fixtures',
        description:
          'Plastic injection steel mold, LSR cold-runner silicone mold, precision CNC test fixtures (amortized over 10,000 sets)',
        cost: 2.5,
      },
      {
        sourceCategory: '總預估物料成本',
        sourceDescription: '預估出廠價 (Ex-work Factory Price)',
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 43,
      },
    ],
  },
  {
    slug: 'clicbot-modular-robot',
    nonBomSha256: '6fcc1dc733ca8f52e182d0964166a3ef3ea25a97031a05d93ff8b0470909e8c0',
    rows: [
      {
        sourceCategory: '塑膠機構與外殼',
        sourceDescription:
          '涵蓋大腦、關節、骨架、車輪的高強度 PC+ABS 精密射出成型件 (具備極高多模穴要求)',
        category: 'Plastic Structure & Shell',
        description:
          'High-strength PC+ABS precision injection-molded parts for the brain, joints, skeletons and wheels (high multi-cavity requirements)',
        cost: 22,
      },
      {
        sourceCategory: 'PCBA 與運算核心',
        sourceDescription:
          'ARM Cortex-A7 SoC 系統板、2.1" IPS 觸控面板、2MP 鏡頭模組、Wi-Fi/藍牙模組、三維感測器',
        category: 'PCBA & Computing Core',
        description:
          'ARM Cortex-A7 SoC system board, 2.1-inch IPS touchscreen, 2MP camera module, Wi-Fi/Bluetooth module and multidimensional sensors',
        cost: 32,
      },
      {
        sourceCategory: '機電傳動與分佈式控制',
        sourceDescription:
          '6 組微型直流減速伺服馬達、6 組 STM32 關節驅動板、絕對角度編碼器、專利磁吸 Pogo Pin 總成',
        category: 'Electromechanical Drive & Distributed Control',
        description:
          '6x micro DC geared servo motors, 6x STM32 joint driver boards, absolute angle encoders and patented magnetic Pogo Pin assemblies',
        cost: 48,
      },
      {
        sourceCategory: '電池與電源管理',
        sourceDescription:
          '1550mAh 高放電倍率鋰聚合物電池 (封裝於大腦內部)、Type-C 快充與多節點電源分配 IC',
        category: 'Battery & Power Management',
        description:
          '1550mAh high-discharge Li-polymer battery in the brain module, Type-C fast charging and multi-node power-distribution IC',
        cost: 4.5,
      },
      {
        sourceCategory: '包裝與附屬配件',
        sourceDescription: '具備防震結構的大型 EPP/EVA 內襯托盤、高質感印刷外箱、快拆支架、說明書',
        category: 'Packaging & Accessories',
        description:
          'Large shock-resistant EPP/EVA insert tray, premium printed outer box, quick-release supports and manual',
        cost: 6.5,
      },
      {
        sourceCategory: '組裝與自動化測試',
        sourceDescription:
          '伺服齒輪箱精密組裝、模組化 PCBA 燒機測試、視覺 UI 校準、多軸聯動壓力測試',
        category: 'Assembly & Automated Testing',
        description:
          'Precision servo gearbox assembly, modular PCBA burn-in, visual UI calibration and multi-axis linked-load testing',
        cost: 12,
      },
      {
        sourceCategory: '模具攤提與治具',
        sourceDescription:
          '全系統超過 20 套以上形狀各異的精密塑膠與壓鑄模具 (以 10,000 套基準大幅度攤提)',
        category: 'Tooling Amortization & Fixtures',
        description:
          'More than 20 precision plastic and die-casting molds across the system (amortized over 10,000 sets)',
        cost: 15,
      },
      {
        sourceCategory: '總預估物料成本',
        sourceDescription: '預估出廠價 (Ex-work Factory Price)',
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 140,
      },
    ],
  },
  {
    slug: 'lofree-flow-2-keyboard',
    nonBomSha256: '58802c5ade7a08f91d7219dc938ffa88d53e93d2e31996bed5aad3a2f38edece',
    rows: [
      {
        sourceCategory: '金屬外殼與鍵帽',
        sourceDescription:
          '航空鋁合金上下蓋全 CNC 鍛造加工與陽極氧化處理、84 顆 PBT/PC 雙色注塑鍵帽',
        category: 'Metal Shell & Keycaps',
        description:
          'Full CNC forging/machining and anodizing of aerospace-aluminum top and bottom shells, plus 84 PBT/PC double-shot keycaps',
        cost: 24.5,
      },
      {
        sourceCategory: 'PCBA 與電子元件',
        sourceDescription:
          '三模無線微控制器 (MCU)、高頻 LED 驅動晶片、凱華五金熱插拔底座、高亮度 SMD LEDs、沉金工藝 PCB',
        category: 'PCBA & Electronic Components',
        description:
          'Tri-mode wireless MCU, high-frequency LED driver IC, Kailh metal hot-swap sockets, high-brightness SMD LEDs and ENIG PCB',
        cost: 12.5,
      },
      {
        sourceCategory: '軸體與聲學結構材',
        sourceDescription:
          '84 顆凱華全 POM 矮軸 (Cloud Series)、Poron 夾心棉、IXPE 軸下墊、矽膠 Gasket 墊片',
        category: 'Switches & Acoustic Structure Materials',
        description:
          '84 Kailh Cloud Series full-POM low-profile switches, Poron sandwich foam, IXPE switch pads and silicone gasket pads',
        cost: 22,
      },
      {
        sourceCategory: '電池與電源模組',
        sourceDescription: '3000mAh 扁平化鋰聚合物電池、獨立 Type-C 接口子板',
        category: 'Battery & Power Module',
        description: '3000mAh low-profile Li-polymer battery and independent Type-C daughterboard',
        cost: 3,
      },
      {
        sourceCategory: '包裝與附屬配件',
        sourceDescription: '尼龍編織 Type-C 數據線、金屬二合一拔軸拔鍵器、高密度緩衝環保零售包裝盒',
        category: 'Packaging & Accessories',
        description:
          'Braided nylon Type-C data cable, metal 2-in-1 switch/keycap puller and high-density protective eco retail box',
        cost: 3.5,
      },
      {
        sourceCategory: '組裝與自動化測試',
        sourceDescription:
          'SMT 貼片製程、全自動按鍵觸發與 RF 射頻測試、VIA 開源韌體燒錄、軸體潤滑抽檢',
        category: 'Assembly & Automated Testing',
        description:
          'SMT, automated key actuation and RF testing, VIA firmware flashing and switch-lubrication sampling inspection',
        cost: 4.5,
      },
      {
        sourceCategory: '模具攤提與治具',
        sourceDescription:
          'CNC 專用加工夾具、PBT 雙色鍵帽模具、POM 軸體專用模具 (以 10,000 套作為攤提基準)',
        category: 'Tooling Amortization & Fixtures',
        description:
          'Dedicated CNC machining fixtures, PBT double-shot keycap molds and POM switch molds (amortized over 10,000 sets)',
        cost: 3.5,
      },
      {
        sourceCategory: '總預估物料成本',
        sourceDescription: '預估出廠價 (Ex-work Factory Price)',
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 73.5,
      },
    ],
  },
];
