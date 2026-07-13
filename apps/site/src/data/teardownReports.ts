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
          'PC/ABS cavity, 8-layer ceramic coating, titanium alloy memory skeleton, medical LSR overmolding',
        cost: 8.5,
      },
      {
        category: 'PCBA & Electronics',
        description:
          'BES2600YP BT SoC, Awinic AW86862 pressure IC, 6x MEMS mic array, audio amp, MCU',
        cost: 15.2,
      },
      {
        category: 'Acoustic Driver',
        description:
          '23x10mm custom dual-layer dynamic driver (paired), metal mesh & tuning filter',
        cost: 6.5,
      },
      {
        category: 'Battery & Power',
        description:
          '150mAh cylindrical battery (x2), 1150mAh Li-Po (case), SY8809 power management IC',
        cost: 4.8,
      },
      {
        category: 'Packaging & Accessories',
        description: 'High-weight rigid box, Type-C cable, warranty card & manual',
        cost: 2.0,
      },
      {
        category: 'Assembly & Testing',
        description:
          'SMT, acoustic anechoic chamber pairing test, RF antenna calibration, IPX4 seal test',
        cost: 3.5,
      },
      {
        category: 'Tooling & Fixtures',
        description:
          'Plastic injection mold, LSR cold-runner mold, precision CNC test fixtures (10K unit amortization)',
        cost: 2.5,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per unit',
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
      'ClicBot by KEYi Tech represents a major leap in consumer-grade robotics. It\'s a modular educational robot with high emotional interaction and programming capability. The patented wire-free magnetic snap-on modules allow reconfiguration into bipedal robots, quadruped dogs, wheeled cars, multi-axis arms, and more. It attracted 1,600+ backers on Kickstarter raising $903,248.',
    marketAnalysis:
      'ClicBot solves two pain points of traditional STEM toys: (1) assembly is too complex with wires, causing frustration in young children; (2) poor interactivity, becoming mere command executors. ClicBot combines a personality engine designed by Pixar WALL-E animator Carlos Baena with 200+ emotional reactions. Programming ranges from manual teaching to Google Blockly to Python.',
    hardwareTeardown:
      'All module shells use high-strength PC/ABS. Connectors use patented "inner-outer ring snap + magnetic guidance" with 4-5 gold-plated Pogo Pins per interface for power/ground/UART/CAN bus. Brain module features ARM Cortex-A7 SoC (Allwinner/Rockchip), 2.1" circular IPS touchscreen, 2MP camera, gesture sensor, microphone array. Joint modules use micro DC gear motors with absolute angle encoders. Distributed cluster control architecture.',
    bomBreakdown: [
      {
        category: 'Brain Module',
        description:
          'ARM Cortex-A7 SoC, 2.1" IPS touchscreen, 2MP camera, gesture sensor, mic array, 3x capacitive touch sensors',
        cost: 45.0,
      },
      {
        category: 'Joint Modules (x6)',
        description:
          'Micro DC gear motor, precision gearbox, absolute encoder, Pogo Pin connector, PC/ABS shell per module',
        cost: 54.0,
      },
      {
        category: 'Skeleton & Wheel Modules',
        description: '3x skeleton, 4x wheel, base & gripper accessories, PC/ABS construction',
        cost: 18.0,
      },
      {
        category: 'PCBA & Electronics',
        description: 'Distributed control boards, motor drivers, sensor ICs across all modules',
        cost: 12.0,
      },
      {
        category: 'Battery & Power',
        description: 'Li-Po batteries in brain and joint modules, power management ICs',
        cost: 6.0,
      },
      {
        category: 'Assembly & Testing',
        description: 'SMT, module calibration, communication integrity test, drop test',
        cost: 3.0,
      },
      {
        category: 'Tooling & Fixtures',
        description: 'Multi-cavity precision molds for snap-fit features (10K unit amortization)',
        cost: 2.0,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per Standard Kit',
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
        category: 'Aluminum CNC Shell',
        description: 'Full CNC aerospace aluminum top & bottom, anodized finish',
        cost: 22.0,
      },
      {
        category: 'Switches (84x)',
        description: 'Kailh Cloud Series full POM low-profile switches, hot-swap sockets',
        cost: 16.8,
      },
      {
        category: 'Keycaps (84x)',
        description: 'PBT+PC double-shot injection, 0.23mm chamfered edges',
        cost: 8.4,
      },
      {
        category: 'PCBA & Electronics',
        description: 'ARM Cortex-M wireless SoC, LED matrix driver, 2.4GHz dongle, BT antenna',
        cost: 9.5,
      },
      {
        category: 'Sound Dampening',
        description: 'Poron sandwich foam, IXPE switch pads, Gasket silicone pads',
        cost: 4.2,
      },
      {
        category: 'Battery & Power',
        description: 'Li-Po battery, power management IC, USB-C charging circuit',
        cost: 3.6,
      },
      {
        category: 'Assembly & Testing',
        description: 'SMT, switch mounting, torque-controlled screw fastening, key feel QA',
        cost: 5.0,
      },
      {
        category: 'Tooling & Fixtures',
        description: 'CNC fixtures, anodizing racks, assembly jigs (10K unit amortization)',
        cost: 4.0,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per unit (84-key)',
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
