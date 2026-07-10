/**
 * Success Stories — case studies, client logos, and certifications.
 *
 * Each case study follows the STAR framework (Situation, Task, Action, Result)
 * and is displayed in full on the `/success-stories` listing page. Phase 1 keeps
 * the cases short enough that no dynamic detail pages are required.
 */

export interface Metric {
  /** Human-readable metric label, e.g. "Development Time". */
  label: string;
  /** Metric value, e.g. "End-to-end" or "99.5%+ pass rate". */
  value: string;
}

export interface CaseStudy {
  /** URL-safe identifier (kept for future detail-page routing). */
  slug: string;
  /** Project / product display name. */
  title: string;
  /** Client display name (may be anonymised). */
  client: string;
  /** Product category for grouping/badging. */
  category: string;
  /** One-sentence elevator pitch shown at the top of the card. */
  summary: string;
  /** STAR — the market context and client challenge. */
  situation: string;
  /** STAR — the objective we were engaged to deliver. */
  task: string;
  /** STAR — what our team did, end to end. */
  action: string;
  /** STAR — the outcome and business impact. */
  result: string;
  /** Capability tags surfaced as chips on the card. */
  capabilities: string[];
  /** Headline metrics rendered in a compact grid. */
  metrics: Metric[];
}

export interface ClientLogo {
  /** Client display name shown in the logo wall. */
  name: string;
  /** Optional logo image path (SVG/PNG); falls back to a text wordmark. */
  logo?: string;
}

export interface Certification {
  /** Certification display name, e.g. "CE Certification". */
  name: string;
  /** Short description of what the certification covers. */
  description: string;
}

export const caseStudies: CaseStudy[] = [
  {
    slug: 'childrens-sleep-training-clock',
    title: "Children's Sleep Training Clock",
    client: 'Leading Children\u2019s Brand (pabobo)',
    category: 'Consumer Goods',
    summary:
      'Complete OEM development of a sleep-training clock combining visual wake-up indicators, projection lighting, alarm functions, and a nightlight in a child-friendly design.',
    situation:
      'The client needed an innovative children\u2019s product that combines multiple functions (clock, projector, nightlight, alarm) into a single child-safe device. The product required careful industrial design to appeal to both children and parents.',
    task:
      'Transform the client\u2019s concept into a market-ready consumer product with child-friendly design, safety compliance, and reliable manufacturing at scale.',
    action:
      'Our team provided complete OEM development services including industrial design, structural engineering, prototype validation, tooling development, mass production, and customized packaging. We managed the entire lifecycle from initial concept to retail-ready packaging through a seamless end-to-end development process.',
    result:
      'The product successfully launched and is sold through major retail channels. The project demonstrated our ability to transform innovative concepts into market-ready consumer products.',
    capabilities: [
      'Product Design',
      'Engineering Development',
      'Tooling',
      'Manufacturing',
      'Packaging Design',
    ],
    metrics: [
      { label: 'Development Time', value: 'End-to-end' },
      {
        label: 'Functions',
        value: '4-in-1 (Clock, Projector, Nightlight, Alarm)',
      },
      { label: 'Safety Compliance', value: 'CE/FCC certified' },
    ],
  },
  {
    slug: 'disc-repair-system',
    title: 'Disc Repair System',
    client: 'Precision Products Client',
    category: '3C Electronics',
    summary:
      'Precision mechanical product manufacturing featuring a patented manual disc-repair mechanism designed to restore scratched CDs, DVDs, and gaming discs through a carefully engineered resurfacing process.',
    situation:
      'The client had a patented disc repair mechanism that required precision manufacturing to function reliably. The product needed to handle various disc types (CD, DVD, gaming discs) with consistent quality.',
    task:
      'Manufacture a mechanically sophisticated consumer product with precision tooling, consistent quality, and reliable assembly at scale.',
    action:
      'Our scope included mechanical structure optimization, precision tooling, component production, assembly, quality control, and retail packaging. We applied precision engineering expertise to ensure the patented resurfacing mechanism worked flawlessly across thousands of units.',
    result:
      'The successful launch demonstrated our capability to manufacture mechanically sophisticated consumer products with consistent quality and reliability at scale.',
    capabilities: [
      'Precision Engineering',
      'Mold Development',
      'Assembly Manufacturing',
      'Quality Control',
      'OEM Production',
    ],
    metrics: [
      { label: 'Patented Mechanism', value: 'Yes' },
      { label: 'Disc Types', value: 'CD, DVD, Gaming Discs' },
      { label: 'Quality Rate', value: '99.5%+ pass rate' },
    ],
  },
];

export const clientLogos: ClientLogo[] = [
  { name: 'Artcoustic' },
  { name: 'Audio Diversity' },
  { name: 'CoreMee' },
  { name: 'DI' },
  { name: 'pabobo' },
  { name: 'Education Institutions' },
];

export const certifications: Certification[] = [
  {
    name: 'CE Certification',
    description: 'European conformity for health, safety, and environmental standards.',
  },
  {
    name: 'EMC Certification',
    description: 'Electromagnetic compatibility ensuring devices emit and tolerate interference correctly.',
  },
  {
    name: 'FCC Certification',
    description: 'U.S. Federal Communications Commission compliance for electronic products.',
  },
  {
    name: 'JD Certification',
    description: 'Quality and compliance verification for retail channel distribution.',
  },
  {
    name: 'AS1 Speaker Product Cert',
    description: 'Acoustic performance certification for speaker product lines.',
  },
  {
    name: 'OP1 Gaming Headset Cert',
    description: 'Performance and safety certification for gaming headset products.',
  },
  {
    name: 'SC3 Headphones Product Cert',
    description: 'Product certification covering headphone electrical and acoustic specs.',
  },
  {
    name: 'CS1 Speaker Product Cert',
    description: 'Speaker product certification for component and system-level quality.',
  },
];

/** Return all case studies (ordering is up to the caller). */
export function getAllCaseStudies(): CaseStudy[] {
  return caseStudies;
}

/** Resolve a single case study by its slug, or `undefined` if not found. */
export function getCaseStudyBySlug(slug: string): CaseStudy | undefined {
  return caseStudies.find((study) => study.slug === slug);
}
