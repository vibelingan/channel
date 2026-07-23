import assert from 'node:assert/strict';
import test from 'node:test';
import { type BomLine, teardownReports } from './teardownReports.ts';

const expectedBomBySlug: Record<string, BomLine[]> = {
  'oladance-ows-pro': [
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
      cost: 2,
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
      cost: 43,
    },
  ],
  'clicbot-modular-robot': [
    {
      category: 'Plastic Structure & Shell',
      description:
        'High-strength PC+ABS precision injection-molded parts for the brain, joints, skeletons and wheels (high multi-cavity requirements)',
      cost: 22,
    },
    {
      category: 'PCBA & Computing Core',
      description:
        'ARM Cortex-A7 SoC system board, 2.1-inch IPS touchscreen, 2MP camera module, Wi-Fi/Bluetooth module and multidimensional sensors',
      cost: 32,
    },
    {
      category: 'Electromechanical Drive & Distributed Control',
      description:
        '6x micro DC geared servo motors, 6x STM32 joint driver boards, absolute angle encoders and patented magnetic Pogo Pin assemblies',
      cost: 48,
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
      cost: 12,
    },
    {
      category: 'Tooling Amortization & Fixtures',
      description:
        'More than 20 precision plastic and die-casting molds across the system (amortized over 10,000 sets)',
      cost: 15,
    },
    {
      category: 'Total',
      description: 'Estimated ex-work factory price',
      cost: 140,
    },
  ],
  'lofree-flow-2-keyboard': [
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
      cost: 22,
    },
    {
      category: 'Battery & Power Module',
      description: '3000mAh low-profile Li-polymer battery and independent Type-C daughterboard',
      cost: 3,
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
};

test('teardown BOM rows remain faithful to the client source tables', () => {
  assert.deepEqual(
    teardownReports.map(({ slug, bomBreakdown }) => ({ slug, bomBreakdown })),
    Object.entries(expectedBomBySlug).map(([slug, bomBreakdown]) => ({ slug, bomBreakdown })),
  );

  for (const report of teardownReports) {
    const total = report.bomBreakdown.at(-1);
    const lineTotalInCents = report.bomBreakdown
      .slice(0, -1)
      .reduce((sum, line) => sum + Math.round(line.cost * 100), 0);
    assert.equal(total?.category, 'Total');
    assert.equal(total.cost, report.estBomCost);
    assert.equal(lineTotalInCents, Math.round(report.estBomCost * 100));
  }
});
