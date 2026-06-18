import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@vibelingan-channel/auth/password';
import { optionalEnv } from '@vibelingan-channel/shared';
import type { JsonFileAdapter } from './json-adapter.ts';

/** Inject a little demo data so the admin UI has something to show on first run. */
export async function seed(adapter: JsonFileAdapter): Promise<void> {
  // Bootstrap admin account. Email/password are env-configurable for parity
  // with production; defaults are convenient for local development.
  const adminEmail = optionalEnv('ADMIN_EMAIL', 'admin@channel.local').toLowerCase();
  const adminPassword = optionalEnv('ADMIN_PASSWORD', 'admin');
  adapter.seedIfEmpty('users', [
    {
      username: 'admin',
      email: adminEmail,
      role: 'admin',
      status: 'active',
      passwordHash: await hashPassword(adminPassword),
      loginCount: 0,
    },
    // Sample accounts (local dev only) — one per role tier, all password "password".
    {
      username: 'contributor',
      email: 'contributor@channel.local',
      role: 'contributor',
      status: 'active',
      passwordHash: await hashPassword('password'),
      loginCount: 0,
    },
    {
      username: 'member',
      email: 'member@channel.local',
      role: 'member',
      status: 'active',
      passwordHash: await hashPassword('password'),
      loginCount: 0,
    },
    {
      username: 'viewer',
      email: 'viewer@channel.local',
      role: 'viewer',
      status: 'active',
      passwordHash: await hashPassword('password'),
      loginCount: 0,
    },
    {
      username: 'newbie',
      email: 'newbie@channel.local',
      role: '',
      status: 'active',
      passwordHash: await hashPassword('password'),
      loginCount: 0,
    },
    // A larger synthetic user base so pagination / filtering have something to
    // chew on during local development.
    ...(await generateUsers(140)),
  ]);

  adapter.seedIfEmpty('files', [
    {
      _id: 'sample-drawing',
      name: 'enclosure-rev-b.txt',
      mimeType: 'text/plain',
      data: Buffer.from(
        'Sample OEM drawing placeholder.\nReplace with the real CAD/PDF file.\n',
      ).toString('base64'),
    },
  ]);

  adapter.seedIfEmpty('oemProjects', [
    {
      company: 'Northwind Gadgets',
      contact: 'Dana Lee',
      email: 'dana@northwind.example',
      whatsapp: '+1 555 010 2030',
      category: 'Electronics',
      quantity: 5000,
      drawingName: 'enclosure-rev-b.txt',
      drawing: 'sample-drawing',
      status: 'new',
    },
    {
      company: 'Brightline Audio',
      contact: 'Marco Rossi',
      email: 'marco@brightline.example',
      whatsapp: '',
      category: 'Headphones',
      quantity: 2000,
      drawingName: '',
      drawing: '',
      status: 'reviewing',
    },
  ]);

  // Images are seeded as a collection of base64 bytes — mirroring how
  // wx-server-sdk will store image binaries in production. Catalog items only
  // reference image ids (see `imageIds`), never file paths.
  adapter.seedIfEmpty('images', loadImageBytes());
  // Seeded catalog items are published so the demo storefront has content;
  // items created later through the dashboard start unpublished (disabled).
  adapter.seedIfEmpty(
    'products',
    PRODUCTS.map((p) => ({ ...p, published: true })),
  );
  adapter.seedIfEmpty(
    'overstock',
    [...OVERSTOCK, ...generateOverstock(180)].map((p) => ({ ...p, published: true })),
  );
}

/** Generate `count` synthetic user accounts (all share the password "password"). */
async function generateUsers(count: number): Promise<Record<string, unknown>[]> {
  const passwordHash = await hashPassword('password');
  const roles = ['', 'viewer', 'member', 'contributor'];
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i++) {
    const num = String(i).padStart(3, '0');
    out.push({
      username: `user${num}`,
      email: `user${num}@channel.local`,
      role: roles[i % roles.length],
      status: i % 9 === 0 ? 'suspended' : 'active',
      passwordHash,
      loginCount: (i * 7) % 50,
    });
  }
  return out;
}

/** Generate `count` synthetic overstock listings to exercise the grid at scale. */
function generateOverstock(count: number): Record<string, unknown>[] {
  const categories = [
    'electronics',
    'headphones',
    'phone-accessories',
    'home',
    'promotional',
    'seasonal',
  ];
  const prefixes: Record<string, string> = {
    electronics: 'EL',
    headphones: 'HP',
    'phone-accessories': 'PA',
    home: 'HM',
    promotional: 'PR',
    seasonal: 'SE',
  };
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i++) {
    const category = categories[i % categories.length] ?? 'electronics';
    const num = String(i).padStart(4, '0');
    const unitPrice = Number((2 + ((i * 3) % 60) + (i % 10) / 10).toFixed(2));
    out.push({
      name: `Clearance Lot ${num}`,
      category,
      productCode: `OS-${prefixes[category]}-${9000 + i}`,
      description: `Synthetic overstock listing #${num} for local pagination testing.`,
      inventory: (i * 37) % 5000,
      moq: 100 * (1 + (i % 5)),
      unitPrice,
      clearancePrice: Number((unitPrice * 0.6).toFixed(2)),
      wholesalePrice: Number((unitPrice * 0.8).toFixed(2)),
      vipPrice: Number((unitPrice * 0.55).toFixed(2)),
      imageIds: [],
    });
  }
  return out;
}

/**
 * Folder holding the source image assets (svg/png/jpg…) that get ingested into
 * the `images` byte collection on first run. These live with the seed, not in
 * the site's public folder — the storefront only ever loads images from the
 * collection via `/api/images/:id`.
 */
const SEED_ASSETS_DIR = fileURLToPath(new URL('../seed-assets/products', import.meta.url));

/** Map a file extension to an image MIME type. */
const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Stable image id derived from a file name, e.g. "hp-graphite.svg" -> "hp-graphite". */
function imageId(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Read every supported image from disk and store it as a base64 byte record. */
function loadImageBytes(): Record<string, unknown>[] {
  let files: string[] = [];
  try {
    files = readdirSync(SEED_ASSETS_DIR);
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) continue; // skip non-image files
    records.push({
      _id: imageId(file),
      name: file,
      mimeType,
      data: readFileSync(`${SEED_ASSETS_DIR}/${file}`).toString('base64'),
    });
  }
  // A generic fallback used when a catalog item has no image of its own.
  records.push({
    _id: '_placeholder',
    name: 'placeholder.svg',
    mimeType: 'image/svg+xml',
    data: Buffer.from(PLACEHOLDER_SVG).toString('base64'),
  });
  return records;
}

const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="No image">' +
  '<rect width="400" height="400" fill="#eef1f6"/>' +
  '<path d="M120 250l50-60 40 45 30-35 40 50z" fill="#c2cbd9"/>' +
  '<circle cx="160" cy="150" r="26" fill="#c2cbd9"/>' +
  '<text x="200" y="330" text-anchor="middle" fill="#94a0b3" font-family="system-ui,sans-serif" font-size="22">No image</text>' +
  '</svg>';

/** Reference one or more seeded images by id. */
const G = (...ids: string[]) => ids;

// Dummy headphone catalog used for local development. Replace with the real
// CloudBase `products` collection in production.
const PRODUCTS: Record<string, unknown>[] = [
  {
    name: 'AuraBeat Pro Studio',
    category: 'wired',
    series: 'AuraBeat',
    modName: 'AB-200',
    modType: 'Over-ear · Closed-back',
    description: 'Studio-grade wired over-ear headphones with 40mm drivers and detachable cable.',
    moq: 500,
    unitPrice: 13.5,
    wholesalePrice: 10.9,
    vipPrice: 8.4,
    imageIds: G('hp-graphite', 'hp-graphite-2'),
  },
  {
    name: 'AuraBeat Classic',
    category: 'wired',
    series: 'AuraBeat',
    modName: 'AB-120',
    modType: 'On-ear · Foldable',
    description: 'Lightweight everyday wired headphones with balanced sound and inline mic.',
    moq: 1000,
    unitPrice: 7.9,
    wholesalePrice: 6.2,
    vipPrice: 4.8,
    imageIds: G('hp-blue', 'hp-blue-2'),
  },
  {
    name: 'WorkComm Mono',
    category: 'office',
    series: 'WorkComm',
    modName: 'WC-15',
    modType: 'Mono headset · Noise-cancel mic',
    description: 'Single-ear office headset with noise-cancelling boom mic for call centers.',
    moq: 300,
    unitPrice: 11.0,
    wholesalePrice: 9.1,
    vipPrice: 7.0,
    imageIds: G('hp-office', 'hp-office-2'),
  },
  {
    name: 'WorkComm Duo',
    category: 'office',
    series: 'WorkComm',
    modName: 'WC-30',
    modType: 'Stereo headset · USB-C',
    description: 'Binaural USB-C office headset tuned for clear conferencing and long shifts.',
    moq: 300,
    unitPrice: 15.5,
    wholesalePrice: 12.8,
    vipPrice: 9.9,
    imageIds: G('hp-office', 'hp-graphite-2'),
  },
  {
    name: 'SonicAir 5',
    category: 'bluetooth',
    series: 'SonicAir',
    modName: 'SA-500',
    modType: 'True wireless · ANC',
    description: 'True wireless earbuds with active noise cancellation and 28h case battery.',
    moq: 500,
    unitPrice: 18.0,
    wholesalePrice: 14.5,
    vipPrice: 11.2,
    imageIds: G('hp-buds', 'hp-buds-2'),
  },
  {
    name: 'SonicAir Move',
    category: 'bluetooth',
    series: 'SonicAir',
    modName: 'SA-220',
    modType: 'Over-ear · BT 5.3',
    description: 'Wireless over-ear headphones with 50-hour playtime and fast charging.',
    moq: 500,
    unitPrice: 21.5,
    wholesalePrice: 17.4,
    vipPrice: 13.6,
    imageIds: G('hp-blue', 'hp-buds-2'),
  },
];

// Dummy overstock / clearance catalog. Inventory values are intentionally
// varied to exercise the Available / Low Stock / Sold out states.
const OVERSTOCK: Record<string, unknown>[] = [
  {
    name: 'PixelView 10" Tablet (Refurb)',
    category: 'electronics',
    productCode: 'OS-EL-1001',
    description: 'Overstock 10-inch Android tablets, factory refurbished, original packaging.',
    inventory: 1240,
    moq: 100,
    unitPrice: 42.0,
    clearancePrice: 27.5,
    wholesalePrice: 33.0,
    vipPrice: 26.0,
    imageIds: G('os-tablet', 'os-tablet-2'),
  },
  {
    name: 'PowerCell 20000mAh Power Bank',
    category: 'electronics',
    productCode: 'OS-EL-1002',
    description: 'High-capacity USB-C power banks, surplus stock from a cancelled order.',
    inventory: 86,
    moq: 200,
    unitPrice: 11.5,
    clearancePrice: 6.9,
    wholesalePrice: 9.2,
    vipPrice: 6.4,
    imageIds: G('os-powerbank', 'os-powerbank-2'),
  },
  {
    name: 'AuraBeat Classic (Liquidation)',
    category: 'headphones',
    productCode: 'OS-HP-2001',
    description: 'End-of-line on-ear headphones, fully tested, bulk clearance pricing.',
    inventory: 0,
    moq: 300,
    unitPrice: 7.9,
    clearancePrice: 3.8,
    wholesalePrice: 6.2,
    vipPrice: 3.5,
    imageIds: G('hp-blue', 'hp-blue-2'),
  },
  {
    name: 'SonicAir Buds (Overstock)',
    category: 'headphones',
    productCode: 'OS-HP-2002',
    description: 'True-wireless earbuds, surplus inventory, retail-ready packaging.',
    inventory: 540,
    moq: 200,
    unitPrice: 12.0,
    clearancePrice: 7.2,
    wholesalePrice: 9.5,
    vipPrice: 6.8,
    imageIds: G('hp-buds', 'hp-buds-2'),
  },
  {
    name: 'FlexGuard USB-C Cable 3-Pack',
    category: 'phone-accessories',
    productCode: 'OS-PA-3001',
    description: 'Braided 1m USB-C cables in 3-packs, overstock from holiday season.',
    inventory: 3200,
    moq: 500,
    unitPrice: 3.2,
    clearancePrice: 1.6,
    wholesalePrice: 2.4,
    vipPrice: 1.4,
    imageIds: G('os-cable', 'os-cable-2'),
  },
  {
    name: 'ClearShield Phone Case (Assorted)',
    category: 'phone-accessories',
    productCode: 'OS-PA-3002',
    description: 'Assorted transparent phone cases for popular models, mixed clearance lot.',
    inventory: 64,
    moq: 300,
    unitPrice: 2.5,
    clearancePrice: 0.9,
    wholesalePrice: 1.8,
    vipPrice: 0.8,
    imageIds: G('os-case', 'os-case-2'),
  },
  {
    name: 'BrewMate Electric Kettle 1.7L',
    category: 'home',
    productCode: 'OS-HM-4001',
    description: 'Stainless-steel electric kettles, surplus stock, EU + UK plug options.',
    inventory: 410,
    moq: 100,
    unitPrice: 14.0,
    clearancePrice: 8.5,
    wholesalePrice: 11.0,
    vipPrice: 8.0,
    imageIds: G('os-kettle', 'os-kettle-2'),
  },
  {
    name: 'AromaGlow LED Diffuser',
    category: 'home',
    productCode: 'OS-HM-4002',
    description: 'Ultrasonic aroma diffusers with ambient LED, overstock clearance.',
    inventory: 28,
    moq: 200,
    unitPrice: 9.0,
    clearancePrice: 4.4,
    wholesalePrice: 7.0,
    vipPrice: 4.0,
    imageIds: G('os-diffuser', 'os-diffuser-2'),
  },
  {
    name: 'Branded Travel Mug (Blank)',
    category: 'promotional',
    productCode: 'OS-PR-5001',
    description: 'Double-wall stainless travel mugs, blank for custom branding, bulk lot.',
    inventory: 1850,
    moq: 500,
    unitPrice: 4.5,
    clearancePrice: 2.3,
    wholesalePrice: 3.5,
    vipPrice: 2.1,
    imageIds: G('os-mug', 'os-mug-2'),
  },
  {
    name: 'Eco Tote Bag (Canvas)',
    category: 'promotional',
    productCode: 'OS-PR-5002',
    description: 'Natural canvas tote bags, promotional surplus, ready for screen printing.',
    inventory: 95,
    moq: 1000,
    unitPrice: 1.8,
    clearancePrice: 0.85,
    wholesalePrice: 1.3,
    vipPrice: 0.75,
    imageIds: G('os-tote', 'os-tote-2'),
  },
  {
    name: 'Holiday String Lights 10m',
    category: 'seasonal',
    productCode: 'OS-SE-6001',
    description: 'Warm-white LED string lights, post-season overstock, indoor/outdoor rated.',
    inventory: 720,
    moq: 200,
    unitPrice: 5.5,
    clearancePrice: 2.6,
    wholesalePrice: 4.2,
    vipPrice: 2.4,
    imageIds: G('os-lights', 'os-lights-2'),
  },
  {
    name: 'Summer Beach Cooler Bag',
    category: 'seasonal',
    productCode: 'OS-SE-6002',
    description: 'Insulated cooler bags, end-of-summer clearance, foldable design.',
    inventory: 0,
    moq: 300,
    unitPrice: 8.0,
    clearancePrice: 3.9,
    wholesalePrice: 6.0,
    vipPrice: 3.6,
    imageIds: G('os-cooler', 'os-cooler-2'),
  },
];
