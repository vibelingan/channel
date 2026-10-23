import { readFileSync } from 'node:fs';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalizeJson, parseStrictJson } from './canonical.ts';
import { ContractValidationError } from './errors.ts';
import type {
  Approval,
  ControlCommand,
  InquirySubmitted,
  MailSnapshot,
  SalesRunContext,
} from './types.generated.ts';

export type {
  InquirySubmitted,
  MailSnapshot,
  ControlCommand,
  Approval,
  SalesRunContext,
} from './types.generated.ts';
export { canonicalizeJson, hashCanonicalJson, parseStrictJson } from './canonical.ts';
export { ContractValidationError } from './errors.ts';

export interface ContractMap {
  inquiry: InquirySubmitted;
  'mail-snapshot': MailSnapshot;
  'control-command': ControlCommand;
  approval: Approval;
  'run-context': SalesRunContext;
}
export type ContractKind = keyof ContractMap;
export const CONTRACT_KINDS: readonly ContractKind[] = [
  'inquiry',
  'mail-snapshot',
  'control-command',
  'approval',
  'run-context',
];
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv);
const validators = new Map(
  CONTRACT_KINDS.map((kind) => [
    kind,
    ajv.compile(
      JSON.parse(readFileSync(new URL(`../schemas/${kind}.schema.json`, import.meta.url), 'utf8')),
    ),
  ]),
);

export function validateContract<K extends ContractKind>(kind: K, value: unknown): ContractMap[K] {
  const validator = validators.get(kind);
  if (!validator) throw new ContractValidationError('Unknown contract kind');
  const copy: unknown = JSON.parse(canonicalizeJson(value));
  if (!validator(copy)) {
    throw new ContractValidationError(
      `Invalid ${kind}: ${validator.errors?.[0]?.keyword ?? 'schema'}`,
    );
  }
  return copy as ContractMap[K];
}

export function parseContract<K extends ContractKind>(kind: K, raw: string): ContractMap[K] {
  return validateContract(kind, parseStrictJson(raw));
}
