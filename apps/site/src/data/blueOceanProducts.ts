/**
 * Blue Ocean concept-product data.
 *
 * Each entry represents an original product concept that Diversity Technology
 * has incubated to fill an underserved market gap — combining frontier
 * components (xMEMS, mmWave radar, edge-AI NPUs) with proven manufacturing
 * partnerships. The data powers the listing page (`/blue-ocean`) and the
 * dynamic detail page (`/blue-ocean/[slug]`).
 */

export interface TechSpec {
  /** Component or technology category, e.g. "Edge AI Processor". */
  category: string;
  /** Detailed component / specification description. */
  spec: string;
  /** The user-facing benefit this specification enables. */
  benefit: string;
}

export interface BomLine {
  /** Cost category, e.g. "BES2800YP SoC & Comms" or "Total". */
  category: string;
  /** Human-readable breakdown description. */
  description: string;
  /** Estimated ex-work cost in USD. */
  cost: number;
}

export interface PartnershipTier {
  /** Collaboration model name, e.g. "White-label" or "Co-Development (JDM)". */
  tier: string;
  /** What the partnership entails for the brand. */
  description: string;
  /** Upfront investment required from the brand. */
  investment: string;
  /** Minimum order quantity (may be a range or "Negotiable"). */
  moq: string;
  /** Estimated time-to-market from engagement to shipment. */
  timeline: string;
}

export interface BlueOceanProduct {
  /** URL-safe identifier used for `/blue-ocean/[slug]`. */
  slug: string;
  /** Product display name. */
  name: string;
  /** One-line marketing tagline. */
  tagline: string;
  /** Product category for grouping/badging. */
  category: string;
  /** Recommended retail price (MSRP) in USD. */
  msrp: number;
  /** Estimated bill-of-materials cost (ex-work) in USD. */
  estBomCost: number;
  /** Minimum order quantity for OEM/ODM production. */
  moq: number;
  /** Concise elevator pitch shown on the listing card. */
  summary: string;
  /** Market-gap analysis describing the unsolved pain points this product addresses. */
  marketGap: string;
  /** Frontier technology specifications with user-facing benefits. */
  techSpecs: TechSpec[];
  /** Itemised BOM cost breakdown; the final row is the total. */
  bomBreakdown: BomLine[];
  /** Three partnership / collaboration models available to brand partners. */
  partnershipTiers: PartnershipTier[];
}

export const blueOceanProducts: BlueOceanProduct[] = [
  {
    slug: 'somniflow-ai-sleep-pods',
    name: 'SomniFlow AI Sleep Pods',
    tagline:
      'AI sleep earbuds with micro-cooling and solid-state MEMS audio',
    category: 'Wearables',
    msrp: 199,
    estBomCost: 48.5,
    moq: 2000,
    summary:
      'Ultra-thin sleep earbuds featuring xMEMS Sycamore solid-state speakers and µCooling micro-cooling chips. Edge AI analyzes sleep stages and generates personalized sleep-aid frequencies. Solves comfort, humidity, and dependency issues of existing sleep wearables.',
    marketGap:
      'Global sleep tech market is growing at double-digit CAGR, but existing sleep earbuds face three unsolved pain points: (1) Traditional dynamic drivers (40-50mm) are too bulky for side-sleeping comfort. (2) Sealed in-ear designs trap humidity up to 85%, causing itching and potential ear infections. (3) Products are mere Bluetooth receivers dependent on smartphones, lacking real-time physiological feedback. SomniFlow fills the gap between "medical-grade comfort" and "consumer-grade pricing."',
    techSpecs: [
      {
        category: 'Acoustic Driver',
        spec: 'xMEMS Sycamore full-silicon MEMS micro-speaker — 85mm³ volume, 150mg weight, 98% smaller than traditional 50mm drivers',
        benefit:
          'Enables <1mm earbud thickness for zero-pressure side sleeping',
      },
      {
        category: 'Thermal Management',
        spec: 'xMEMS Cooling µCooling chip (Fan-on-a-Chip) based on inverse piezoelectric effect',
        benefit:
          'Reduces ear canal humidity by 20% within 5 minutes — world\'s first active dehumidification in earbuds',
      },
      {
        category: 'Core SoC',
        spec: 'Bestechnic BES2800YP 6nm FinFET — dual Cortex-M55 + dual BECO NPU + STAR-MC1',
        benefit:
          'NPU performance 4x previous gen, runs sleep analysis algorithms at microwatt power',
      },
      {
        category: 'Wireless',
        spec: 'Bluetooth 5.4 / LE Audio via Ceva-Waves IP, IBRT patent technology',
        benefit:
          'High throughput, low latency, extends battery life to 14 hours per charge',
      },
    ],
    bomBreakdown: [
      {
        category: 'BES2800YP SoC & Comms',
        description: '6nm FinFET SoC, BT 5.4 module, antenna',
        cost: 8.0,
      },
      {
        category: 'xMEMS Acoustic & Cooling',
        description: 'Sycamore MEMS speakers (x2) + µCooling chips (x2)',
        cost: 18.0,
      },
      {
        category: 'Battery & Enclosure',
        description:
          'High-density micro solid-state batteries, medical-grade hypoallergenic silicone shell',
        cost: 12.0,
      },
      {
        category: 'PCBA SMT & QC',
        description: 'SMT assembly, acoustic + thermal QC testing',
        cost: 10.5,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per unit',
        cost: 48.5,
      },
    ],
    partnershipTiers: [
      {
        tier: 'White-label',
        description:
          'Factory provides EVT/DVT-verified reference hardware. Brand customizes packaging, App UI, and logo printing.',
        investment: 'No upfront tooling cost',
        moq: '2,000 units',
        timeline: '1-3 months to market',
      },
      {
        tier: 'Exclusive Buyout',
        description:
          'Custom ergonomic ID or acoustic tuning with global exclusivity. Brand pays NRE + tooling buyout.',
        investment: '$30,000–$50,000 NRE + tooling',
        moq: '50,000 units/year minimum',
        timeline: '3-6 months to market',
      },
      {
        tier: 'Co-Development (JDM)',
        description:
          'Brand provides clinical algorithms, factory handles firmware porting to BES2800 NPU. Shared IP and R&D risk.',
        investment: 'Shared R&D costs',
        moq: 'Negotiable',
        timeline: '6-12 months to market',
      },
    ],
  },
  {
    slug: 'lumicogni-desktop-ai-hologram',
    name: 'LumiCogni Desktop AI Hologram',
    tagline:
      'Holographic AI study companion for kids with edge AI and mmWave radar',
    category: 'Education',
    msrp: 289,
    estBomCost: 115.0,
    moq: 3000,
    summary:
      'A desktop device that projects 3D holographic images without glasses, combining edge AI (RK3588S 6TOPS NPU) for offline LLM dialogue and 60GHz mmWave radar for non-contact posture detection. Zero screen blue light, zero cloud privacy risk.',
    marketGap:
      'Modern EdTech faces strong "screen anxiety" from parents. Prolonged close-up screen use increases myopia risk in children. Existing smart speakers rely on unstable Wi-Fi and cloud LLMs, causing latency and COPPA/GDPR privacy concerns. LumiCogni targets families with 4-10 year-old children, filling the gap between "high-tech interactive education" and "zero-screen eye protection + zero-cloud privacy."',
    techSpecs: [
      {
        category: 'Edge AI Processor',
        spec: 'Rockchip RK3588S 8nm SoC — 4x Cortex-A76 (2.4GHz) + 4x Cortex-A55, 6 TOPS NPU (INT4/8/16, FP16)',
        benefit:
          'Runs 7B-parameter LLM locally, ensuring children\'s privacy and instant responses',
      },
      {
        category: 'Holographic Optical Engine',
        spec: 'TI DLP160CP/DLP3310 micro-projection module — DMD with 5.4µm pixel pitch, 17° tilt, RGB laser/LED source, 720p HD',
        benefit:
          'Reflective imaging eliminates direct blue light, high-contrast 3D floating projection',
      },
      {
        category: 'Non-contact Sensing',
        spec: '60GHz mmWave radar (TI IWRL6844 / D3 RS-L6432S) — <5cm resolution, MIMO antenna',
        benefit:
          'No-camera design eliminates privacy concerns, cm-level posture tracking and breathing detection (90% accuracy)',
      },
      {
        category: 'Memory & Storage',
        spec: '16GB LPDDR5 RAM (2400MHz), NVMe SSD interface, 8K hardware video decode',
        benefit:
          'Supports large AI model loading and rich holographic content',
      },
    ],
    bomBreakdown: [
      {
        category: 'RK3588S Mainboard',
        description: '8-core SoC, 16GB LPDDR5, PMIC, NVMe interface',
        cost: 45.0,
      },
      {
        category: 'TI DLP Projection Module',
        description: 'DLP160CP/DLP3310 optical engine, DMD, RGB light source',
        cost: 38.0,
      },
      {
        category: '60GHz mmWave Radar',
        description: 'IWRL6844/RS-L6432S module, MIMO antenna array',
        cost: 14.91,
      },
      {
        category: 'Thermal & Acoustic',
        description: 'Active silent cooling fan, microphone array, speakers',
        cost: 8.09,
      },
      {
        category: 'Enclosure & Assembly',
        description: 'Fire-retardant plastic shell, SMT, optical alignment, QC',
        cost: 9.0,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per unit',
        cost: 115.0,
      },
    ],
    partnershipTiers: [
      {
        tier: 'White-label',
        description:
          'Factory provides tested hardware + Android/Ubuntu BSP. Brand develops interactive apps, holographic content, and curriculum.',
        investment: 'No upfront tooling cost',
        moq: '3,000 units',
        timeline: '1-3 months to market',
      },
      {
        tier: 'Exclusive Buyout',
        description:
          'Custom exterior design and optical path for brands like Mattel/Hasbro. Includes IP character integration into device design.',
        investment: '$50,000+ tooling',
        moq: '50,000 units/year minimum',
        timeline: '4-6 months to market',
      },
      {
        tier: 'Co-Development (JDM)',
        description:
          "Factory's firmware team helps port brand's AI models to RK3588S NPU via TensorRT/NCNN quantization. Shared NRE costs.",
        investment: 'Shared R&D costs',
        moq: 'Negotiable',
        timeline: '6-12 months to market',
      },
    ],
  },
  {
    slug: 'aerosense-ai-sports-headband',
    name: 'AeroSense AI Sports Headband',
    tagline:
      'Spatial audio + blind-spot detection for cycling with automotive-grade radar',
    category: 'Sports & Outdoor',
    msrp: 229,
    estBomCost: 65.0,
    moq: 2000,
    summary:
      'A sports headband for cycling and extreme sports with open-ear directional array speakers for 3D navigation audio and 60GHz automotive-grade radar for real-time blind-spot detection. Provides intuitive spatial warnings before collisions.',
    marketGap:
      'Millions of cyclists and skiers face safety and communication challenges. In-ear headphones block critical environmental sounds. Bone conduction headphones suffer from wind noise degradation and cheekbone discomfort. Existing safety gear is purely "passive." AeroSense creates the "Active Safety Wearable" category — combining hi-fi communication with military-grade blind-spot detection in a single lightweight device.',
    techSpecs: [
      {
        category: 'Comms & AI Denoise',
        spec: 'BES2800YP heterogeneous multi-core (Cortex-M55 + BECO NPU), 2.5x AI performance vs BES2700',
        benefit:
          'Neural network wind noise suppression ensures clear calls at 50km/h cycling speed',
      },
      {
        category: 'Directional Acoustic Array',
        spec: 'xMEMS Sycamore solid-state MEMS speaker array (beamforming), IP58 rated',
        benefit:
          'Open-ear design with precise sound projection, no sound leakage, full environmental awareness',
      },
      {
        category: 'Blind-spot Warning',
        spec: '60GHz automotive-grade mmWave radar — <5cm precision, supports up to 300km/h relative velocity',
        benefit:
          'All-weather operation (fog, mud, rain), real-time rear vehicle tracking with 3D spatial audio alerts',
      },
      {
        category: 'Construction',
        spec: 'Titanium alloy frame + polymer elastomer composite, total weight <80g',
        benefit:
          'Ultra-lightweight, impact-resistant, comfortable for extended wear',
      },
    ],
    bomBreakdown: [
      {
        category: 'BES2800 Comms Module',
        description: 'SoC, BT 5.4/Wi-Fi 6, antenna, microphone array',
        cost: 12.0,
      },
      {
        category: 'xMEMS Speaker Array',
        description: 'Sycamore MEMS speakers (x2, beamforming configuration)',
        cost: 25.0,
      },
      {
        category: '60GHz Automotive Radar',
        description: 'Vehicle-grade mmWave radar module, miniaturized',
        cost: 15.0,
      },
      {
        category: 'Structure & Battery',
        description:
          'Titanium alloy frame, polymer elastomer, high-discharge battery',
        cost: 13.0,
      },
      {
        category: 'Total',
        description: 'Estimated ex-work BOM cost per unit',
        cost: 65.0,
      },
    ],
    partnershipTiers: [
      {
        tier: 'White-label',
        description:
          'Factory provides standard headband reference design + firmware. Brand selects colors, grip materials, and packaging.',
        investment: 'No upfront tooling cost',
        moq: '2,000 units',
        timeline: '1-3 months to market',
      },
      {
        tier: 'Exclusive Buyout',
        description:
          'Deep customization of radar algorithm + directional acoustics for brands like Garmin/Oakley. Exclusive design rights.',
        investment: '$40,000–$60,000 tooling',
        moq: '50,000 units/year minimum',
        timeline: '4-6 months to market',
      },
      {
        tier: 'Co-Development (JDM)',
        description:
          "Embed PCBA, radar antenna, and xMEMS speakers directly into partner's carbon fiber helmet design. Joint RF engineering for carbon fiber attenuation.",
        investment: 'Shared R&D costs',
        moq: 'Negotiable',
        timeline: '6-12 months to market',
      },
    ],
  },
];

/** Return all blue ocean concept products. */
export function getAllProducts(): BlueOceanProduct[] {
  return blueOceanProducts;
}

/** Resolve a single product by its slug, or `undefined` if not found. */
export function getProductBySlug(slug: string): BlueOceanProduct | undefined {
  return blueOceanProducts.find((product) => product.slug === slug);
}
