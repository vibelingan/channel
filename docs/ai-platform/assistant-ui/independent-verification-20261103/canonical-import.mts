import { parseStrictJson } from '../../../../packages/sales-contracts/src/canonical.ts';
console.log(JSON.stringify(parseStrictJson('{"verify":true}')));
