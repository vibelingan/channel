/**
 * Teardown Lab report data.
 *
 * Each report is a reverse-engineering deep-dive of a crowdfunded hardware
 * product, covering the BOM estimate, manufacturing risk analysis, and market
 * positioning. Reports are consumed by the listing page (`/teardown-lab`) and
 * the dynamic detail page (`/teardown-lab/[slug]`).
 */

export interface BomLine {
  /** Component / cost category, e.g. "PCBA & Electronics" or "Total". */
  category: string;
  /** Human-readable breakdown description. */
  description: string;
  /** Estimated ex-work cost in USD. */
  cost: number;
}

export interface TeardownReport {
  /** URL-safe identifier used for `/teardown-lab/[slug]`. */
  slug: string;
  /** Product display name. */
  product: string;
  /** Product category for grouping/badging. */
  category: string;
  /** Retail price in USD. */
  retailPrice: number;
  /** Estimated bill-of-materials cost (ex-work) in USD. */
  estBomCost: number;
  /** Estimated gross margin as a percentage (retailPrice minus estBomCost). */
  estMargin: number;
  /** Minimum order quantity for OEM replication. */
  moq: number;
  /** One-sentence elevator pitch shown on the listing card. */
  summary: string;
  /** Full product overview paragraph. */
  overview: string;
  /** Market positioning & pain-point analysis. */
  marketAnalysis: string;
  /** Hardware teardown findings. */
  hardwareTeardown: string;
  /** Itemised BOM cost breakdown; the final row is the total. */
  bomBreakdown: BomLine[];
  /** Manufacturing risk analysis with mitigation strategies. */
  riskAnalysis: string;
}

export const teardownReports: TeardownReport[] = [
  {
    slug: 'oladance-ows-pro',
    product: 'Oladance OWS Pro',
    category: 'Audio & Acoustics',
    retailPrice: 199,
    estBomCost: 43.0,
    estMargin: 78.39,
    moq: 10000,
    summary:
      'Open-ear wearable stereo earbuds with Mobius Design, titanium alloy memory skeleton, and medical-grade LSR. Funded $390K+ on Kickstarter, later acquired by ByteDance.',
    overview:
      'Oladance Wearable Stereo (OWS) Pro defines the premium spec for "full open wearable stereo" earbuds. The flagship features non-in-ear, zero-pressure ergonomic design with a Mobius loop shape. It raised $390K+ on Kickstarter and broke sales records on platforms like Taiwan\'s zeczec. The success even prompted ByteDance to acquire the brand.',
    marketAnalysis:
      'Traditional TWS earbuds cause ear canal pain, increase otitis risk, and create dangerous occlusion during outdoor activities. Oladance OWS Pro uses air-conduction audio and patented Fix Point Noise Screen reverse-wave cancellation to solve sound leakage and bass deficiency in open-ear designs, while maintaining environmental awareness.',
    hardwareTeardown:
      'External shell uses high-strength PC/ABS composite with self-developed "ceramic skin" coating (8-layer process). Skeleton uses aerospace-grade titanium alloy memory wire. Ear hooks use medical-grade LSR (liquid silicone rubber) with IPX4 rating. PCBA features Bestechnic BES2600YP Bluetooth audio SoC (BT 5.3, dual-core DSP), independent amplifier IC driving 23x10mm dual-layer dynamic driver, Awinic AW86862 pressure-sensing IC, 6x MEMS microphone array. Battery: 150mAh steel-shell cylindrical (x2 earbuds) + 1150mAh Li-Po (charging case).',
    bomBreakdown: [
      {
        category: 'Plastic Structure & Shell',
        description:
          'PC/ABS cavity, 8-layer ceramic coating, titanium-alloy memory-metal skeleton, medical-grade LSR overmolding',
        cost: 8.5,
      },
      {
        category: 'PCBA & Electronic Components',
        description:
          'Bestechnic BES2600YP Bluetooth SoC, Awinic AW86862 pressure-sensing IC, 6x MEMS microphone array, independent audio amplifier module, CMS8S5887 MCU',
        cost: 15.2,
      },
      {
        category: 'Acoustic Driver & Chamber',
        description:
          'Paired 23x10mm custom high-precision dual-layer dynamic drivers, metal dust mesh and acoustic tuning filter',
        cost: 6.5,
      },
      {
        category: 'Battery & Power Management',
        description:
          '2x MBT 150mAh steel-shell cylindrical batteries, Hengtai 1150mAh Li-polymer charging-case battery, Siyuan SY8809 power-management IC',
        cost: 4.8,
      },
      {
        category: 'Packaging & Accessories',
        description:
          'High-grade rigid lid-and-base box, Type-C charging cable, anti-counterfeit warranty card and manual',
        cost: 2.0,
      },
      {
        category: 'Assembly & Automated Testing',
        description:
          'SMT, miniature anechoic-chamber pairing test, RF antenna calibration, liquid adhesive sealing and IPX4 airtightness test',
        cost: 3.5,
      },
      {
        category: 'Tooling Amortization & Fixtures',
        description:
          'Plastic injection steel mold, LSR cold-runner silicone mold, precision CNC test fixtures (amortized over 10,000 sets)',
        cost: 2.5,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 43.0,
      },
    ],
    riskAnalysis:
      'Three major manufacturing risks: (1) LSR and PC/ABS dual-shot overmolding adhesion failure — solved with atmospheric plasma surface treatment + primer + cold-runner mold design. (2) Open acoustic chamber sealing and driver frequency response consistency — solved with automated 3-axis UV/PUR dispensing + anechoic chamber test stations with laser vibrometers. (3) Pogo Pin sweat corrosion in extreme sports — solved with Rhodium-Ruthenium or Palladium-Cobalt plating + firmware impedance detection.',
  },
  {
    slug: 'clicbot-modular-robot',
    product: 'ClicBot',
    category: 'STEM & Robotics',
    retailPrice: 449,
    estBomCost: 140.0,
    estMargin: 68.81,
    moq: 10000,
    summary:
      'Modular STEM education robot with magnetic Pogo Pin connectors, 200+ emotional reactions, and programming from drag-to-code to Python. Raised $903K on Kickstarter.',
    overview:
      "ClicBot by KEYi Tech represents a major leap in consumer-grade robotics. It's a modular educational robot with high emotional interaction and programming capability. The patented wire-free magnetic snap-on modules allow reconfiguration into bipedal robots, quadruped dogs, wheeled cars, multi-axis arms, and more. It attracted 1,600+ backers on Kickstarter raising $903,248.",
    marketAnalysis:
      'ClicBot solves two pain points of traditional STEM toys: (1) assembly is too complex with wires, causing frustration in young children; (2) poor interactivity, becoming mere command executors. ClicBot combines a personality engine designed by Pixar WALL-E animator Carlos Baena with 200+ emotional reactions. Programming ranges from manual teaching to Google Blockly to Python.',
    hardwareTeardown:
      'All module shells use high-strength PC/ABS. Connectors use patented "inner-outer ring snap + magnetic guidance" with 4-5 gold-plated Pogo Pins per interface for power/ground/UART/CAN bus. Brain module features ARM Cortex-A7 SoC (Allwinner/Rockchip), 2.1" circular IPS touchscreen, 2MP camera, gesture sensor, microphone array. Joint modules use micro DC gear motors with absolute angle encoders. Distributed cluster control architecture.',
    bomBreakdown: [
      {
        category: 'Plastic Structure & Shell',
        description:
          'High-strength PC+ABS precision injection-molded parts for the brain, joints, skeletons and wheels (high multi-cavity requirements)',
        cost: 22.0,
      },
      {
        category: 'PCBA & Computing Core',
        description:
          'ARM Cortex-A7 SoC system board, 2.1-inch IPS touchscreen, 2MP camera module, Wi-Fi/Bluetooth module and multidimensional sensors',
        cost: 32.0,
      },
      {
        category: 'Electromechanical Drive & Distributed Control',
        description:
          '6x micro DC geared servo motors, 6x STM32 joint driver boards, absolute angle encoders and patented magnetic Pogo Pin assemblies',
        cost: 48.0,
      },
      {
        category: 'Battery & Power Management',
        description:
          '1550mAh high-discharge Li-polymer battery in the brain module, Type-C fast charging and multi-node power-distribution IC',
        cost: 4.5,
      },
      {
        category: 'Packaging & Accessories',
        description:
          'Large shock-resistant EPP/EVA insert tray, premium printed outer box, quick-release supports and manual',
        cost: 6.5,
      },
      {
        category: 'Assembly & Automated Testing',
        description:
          'Precision servo gearbox assembly, modular PCBA burn-in, visual UI calibration and multi-axis linked-load testing',
        cost: 12.0,
      },
      {
        category: 'Tooling Amortization & Fixtures',
        description:
          'More than 20 precision plastic and die-casting molds across the system (amortized over 10,000 sets)',
        cost: 15.0,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 140.0,
      },
    ],
    riskAnalysis:
      'Three major risks: (1) Serial communication signal attenuation & EMI across daisy-chained Pogo Pins — solved with 3-5μ" gold plating, beryllium copper springs, and CAN bus differential signaling. (2) Micro gearbox wear & backlash from backdrivable teaching — solved with POM+PTFE composite gears for first stage and metal gears for final stage. (3) Multi-cavity mold dimensional tolerance for snap-fit consistency — solved with moldflow analysis, closed-loop cavity pressure monitoring, and SPC on critical snap features.',
  },
  {
    slug: 'lofree-flow-2-keyboard',
    product: 'Lofree Flow 2',
    category: '3C Peripherals',
    retailPrice: 159,
    estBomCost: 73.5,
    estMargin: 53.77,
    moq: 10000,
    summary:
      'Low-profile mechanical keyboard with full CNC aluminum body, Kailh POM switches, and triple-mode connectivity. Raised $1.17M on Kickstarter from 8,060+ backers.',
    overview:
      'Lofree Flow 2 defines the ultimate form of "ultra-smooth portable low-profile mechanical keyboard." It features full CNC-forged aluminum alloy body, Kailh co-developed full POM low-profile switches, triple-mode connectivity (Bluetooth, wired, 2.4GHz 1000Hz), VIA open-source key remapping, and Mac/Windows support. It attracted 8,060+ backers raising HK$9,149,151 (~$1.17M USD) on Kickstarter.',
    marketAnalysis:
      'Lofree Flow 2 solves the consumer dilemma: thin keyboards (like Apple Magic Keyboard) use membrane/scissor switches with poor tactile feedback, while custom mechanical keyboards are bulky, too tall, and noisy. Flow 2 combines high-end custom keyboard feel with ultra-thin portability, targeting digital nomads and office aesthetics.',
    hardwareTeardown:
      'Top and bottom shells use aerospace-grade aluminum alloy, fully CNC machined and anodized. Keycaps use PBT+PC double-shot injection with 0.23mm chamfered edges. PCBA features ARM Cortex-M wireless SoC (Nordic nRF52 series), dedicated LED matrix driver IC for per-key backlight and RGB side lighting. Switches are exclusive Kailh Cloud Series full POM low-profile switches. Sound structure: aluminum top plate → POM switch → positioning plate → Poron sandwich foam → IXPE switch pad → PCBA → Gasket silicone pad → aluminum bottom shell.',
    bomBreakdown: [
      {
        category: 'Metal Shell & Keycaps',
        description:
          'Full CNC forging/machining and anodizing of aerospace-aluminum top and bottom shells, plus 84 PBT/PC double-shot keycaps',
        cost: 24.5,
      },
      {
        category: 'PCBA & Electronic Components',
        description:
          'Tri-mode wireless MCU, high-frequency LED driver IC, Kailh metal hot-swap sockets, high-brightness SMD LEDs and ENIG PCB',
        cost: 12.5,
      },
      {
        category: 'Switches & Acoustic Structure Materials',
        description:
          '84 Kailh Cloud Series full-POM low-profile switches, Poron sandwich foam, IXPE switch pads and silicone gasket pads',
        cost: 22.0,
      },
      {
        category: 'Battery & Power Module',
        description: '3000mAh low-profile Li-polymer battery and independent Type-C daughterboard',
        cost: 3.0,
      },
      {
        category: 'Packaging & Accessories',
        description:
          'Braided nylon Type-C data cable, metal 2-in-1 switch/keycap puller and high-density protective eco retail box',
        cost: 3.5,
      },
      {
        category: 'Assembly & Automated Testing',
        description:
          'SMT, automated key actuation and RF testing, VIA firmware flashing and switch-lubrication sampling inspection',
        cost: 4.5,
      },
      {
        category: 'Tooling Amortization & Fixtures',
        description:
          'Dedicated CNC machining fixtures, PBT double-shot keycap molds and POM switch molds (amortized over 10,000 sets)',
        cost: 3.5,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work factory price',
        cost: 73.5,
      },
    ],
    riskAnalysis:
      'Three major risks: (1) Aluminum CNC anodizing color variation & yield — solved with single-heat-number aluminum batch control, automated chemical dosing, and spectrophotometer QC. (2) Hot-swap socket pad ripping on thin PCB — solved with high-temperature lead-free solder paste + post-SMT epoxy reinforcement + ENIG pad finish. (3) Gasket compression inconsistency causing uneven typing feel — solved with servo electric screwdrivers with precision torque control and networked monitoring.',
  },
];

/** Return all teardown reports (newest-first ordering is up to the caller). */
export function getAllReports(): TeardownReport[] {
  return teardownReports;
}

/** Resolve a single report by its slug, or `undefined` if not found. */
export function getReportBySlug(slug: string): TeardownReport | undefined {
  return teardownReports.find((report) => report.slug === slug);
}
