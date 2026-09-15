/** Website policy approved 2026-09-08. Industrial/non-electronic rows are intentionally out of scope. */
import type { ProductFamily } from '@vibelingan-channel/shared';
export const CATEGORY_POLICY_VERSION = 'alibaba-website-2026-09-08-v1';
export const APPROVED_CATEGORY_RULES: readonly {
  sourceCategoryId: string;
  productFamily: ProductFamily | null;
}[] = [
  {
    sourceCategoryId: '152801',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '152805',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '63708',
    productFamily: null,
  },
  {
    sourceCategoryId: '518',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '100001765',
    productFamily: null,
  },
  {
    sourceCategoryId: '100003264',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201340406',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '100010895',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201467503',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201745302',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201775601',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '617',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '100000157',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '100010893',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '141905',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '152802',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '200554009',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201334110',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201335115',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201348002',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201452126',
    productFamily: 'toys',
  },
  {
    sourceCategoryId: '201745801',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201886409',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201888707',
    productFamily: 'toys',
  },
  {
    sourceCategoryId: '201890409',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201930401',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201933601',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '201951703',
    productFamily: 'misc',
  },
  {
    sourceCategoryId: '2601',
    productFamily: 'ai-gadgets',
  },
  {
    sourceCategoryId: '66010102',
    productFamily: 'misc',
  },
];
const exceptions: readonly (readonly [string, string, ProductFamily])[] = [
  ['051a9011-8e4c-408f-acc1-d08e00a10dad', '63708', 'misc'],
  ['20db9073-60fa-443e-a6d3-7e7edc75f0e6', '63708', 'misc'],
  ['22a0bc9b-2eaa-4f6b-ab6e-82a1053df777', '100001765', 'ai-gadgets'],
  ['258394ec-d04d-4777-a0ab-fa1b14ba4375', '100001765', 'toys'],
  ['28f0d1e6-07ee-4953-a99a-eb64054bd77c', '100001765', 'ai-gadgets'],
  ['41a5a18e-80c5-433c-a0e6-efa9d08658b3', '63708', 'misc'],
  ['52786afa-6d3e-4f37-a061-92f93574f15f', '63708', 'misc'],
  ['55d056ed-563c-49f7-ae83-116be5036442', '100001765', 'toys'],
  ['7013a1dc-0810-4df3-a98b-660d1b2ba8dc', '63708', 'misc'],
  ['70bd6aaa-796a-460a-a36d-33c2f0490f49', '100001765', 'ai-gadgets'],
  ['87c936f3-54fb-43b3-abd2-806fedfcffb6', '63708', 'misc'],
  ['89f59908-9302-45cc-aa92-18752d4c3ed4', '100001765', 'ai-gadgets'],
  ['8d8611ca-8c6a-4731-a0db-080977d73283', '63708', 'misc'],
  ['9384703e-d09f-42f8-aa97-8dfbcaf87e04', '100001765', 'toys'],
  ['a5ab40df-d3ff-4baa-ad3a-1aacc4615448', '63708', 'misc'],
  ['b8677602-2935-417d-a8fa-64fb377b9835', '63708', 'misc'],
  ['cfb80022-696c-478d-aaa4-d10e5c1c1d3a', '100001765', 'toys'],
  ['f514ba21-1fe0-4ed4-a729-9f85f6bf9a31', '63708', 'misc'],
];
export function classificationTarget(categoryId: string, productId: string): ProductFamily | null {
  const rule = APPROVED_CATEGORY_RULES.find((row) => row.sourceCategoryId === categoryId);
  if (!rule) return null;
  return (
    rule.productFamily ??
    exceptions.find(([id, category]) => id === productId && category === categoryId)?.[2] ??
    null
  );
}
export function categoryRuleId(categoryId: string): string {
  return `alibaba-icbu-${categoryId}`;
}
