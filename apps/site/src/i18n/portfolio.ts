/**
 * Success Stories (portfolio) page content loader.
 *
 * Mirrors the OEM/site pattern: one markdown file per locale under
 * `content/portfolio/<locale>.md`, all structured strings in frontmatter.
 * Add a locale by dropping in another markdown file — no code changes.
 */

export interface CustomerLogo {
  src: string;
  /** Public brand name, OR an anonymised alias (e.g. "Leading UK Audio Brand"). */
  name: string;
  /** When true, `name` is a category/alias, not a real brand (client-gated). */
  anonymized?: boolean;
  /** Intrinsic pixel dimensions of the normalized logo canvas. */
  width: number;
  height: number;
}

export interface StarCase {
  title: string;
  client: string;
  category: string;
  summary: string;
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  /** STAR framing. */
  situation: string;
  task: string;
  action: string;
  result: string;
  /** Highlighted outcome metrics. */
  metrics?: { value: string; label: string }[];
  capabilities?: string[];
}

export interface PortfolioStat {
  value: string;
  label: string;
}

export interface Certificate {
  src: string;
  label: string;
  kind: 'compliance' | 'design-patent' | 'patent-record';
  /** Intrinsic pixel dimensions of `src`, to reserve layout space (avoid CLS). */
  width: number;
  height: number;
}

export interface PortfolioContent {
  meta: { title: string; description: string };
  hero: {
    eyebrow: string;
    heading: string;
    subheading: string;
    primaryCta: { label: string; href: string };
    secondaryCta: { label: string; href: string };
  };
  stats: { items: PortfolioStat[]; note: string };
  customers: { id: string; eyebrow: string; heading: string; intro: string; logos: CustomerLogo[] };
  cases: { id: string; eyebrow: string; heading: string; intro: string; items: StarCase[] };
  certificates: {
    id: string;
    eyebrow: string;
    heading: string;
    intro: string;
    complianceLabel: string;
    designPatentLabel: string;
    patentRecordLabel: string;
    items: Certificate[];
  };
}

interface MarkdownModule {
  frontmatter: PortfolioContent & { locale?: string };
}

const modules = import.meta.glob<MarkdownModule>('./content/portfolio/*.md', { eager: true });

const BY_LOCALE = new Map<string, PortfolioContent>();
for (const [path, mod] of Object.entries(modules)) {
  const locale = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  if (locale) BY_LOCALE.set(locale, mod.frontmatter);
}

export const DEFAULT_LOCALE = 'en-US';

export function getPortfolioContent(locale: string = DEFAULT_LOCALE): PortfolioContent {
  const content = BY_LOCALE.get(locale) ?? BY_LOCALE.get(DEFAULT_LOCALE);
  if (!content) {
    throw new Error(`No portfolio content for locale "${locale}" or default "${DEFAULT_LOCALE}".`);
  }
  return content;
}
