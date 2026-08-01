/**
 * Server-side query model — shared by the admin grid (UI), the API handler, and
 * the storage adapters. A query is built in the browser, validated on the
 * server, and translated by each adapter into a native query (wx-server-sdk
 * `where`/`orderBy` in production, in-memory predicates in the local mock).
 *
 * Keeping this pure and dependency-free means the grid and the database always
 * agree on what a filter means.
 */

/** Comparison operators available when building a filter clause. */
export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'contains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'isEmpty',
  'isNotEmpty',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** A single field/operator/value condition. */
export interface FilterClause {
  field: string;
  op: FilterOperator;
  /** Omitted for `isEmpty` / `isNotEmpty`. */
  value?: unknown;
}

export type FilterCombinator = 'and' | 'or';

/** A flat list of clauses combined with a single AND/OR. */
export interface FilterModel {
  combinator: FilterCombinator;
  clauses: FilterClause[];
}

export interface SortClause {
  field: string;
  dir: 'asc' | 'desc';
}

/** Operators that do not take a value. */
export function isValuelessOperator(op: FilterOperator): boolean {
  return op === 'isEmpty' || op === 'isNotEmpty';
}

/** Whether a sensible default set of operators applies to a field type. */
export function operatorsForType(type: string): FilterOperator[] {
  switch (type) {
    case 'number':
    case 'date':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'];
    case 'select':
      return ['eq', 'ne', 'in', 'isEmpty', 'isNotEmpty'];
    case 'boolean':
      return ['eq'];
    default:
      return ['contains', 'eq', 'ne', 'startsWith', 'isEmpty', 'isNotEmpty'];
  }
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  startsWith: 'starts with',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  in: 'is any of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

export function operatorLabel(op: FilterOperator): string {
  return OPERATOR_LABELS[op];
}

/**
 * Evaluate a filter model against a plain document in memory. Used by the local
 * JSON adapter (and handy for tests). Production uses wx-server-sdk instead.
 */
export function matchesFilter(doc: Record<string, unknown>, filter: FilterModel): boolean {
  if (filter.clauses.length === 0) return true;
  const results = filter.clauses.map((c) => matchesClause(doc, c));
  return filter.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
}

function matchesClause(doc: Record<string, unknown>, clause: FilterClause): boolean {
  const actual = doc[clause.field];
  const value = clause.value;
  switch (clause.op) {
    case 'eq':
      return looseEquals(actual, value);
    case 'ne':
      return !looseEquals(actual, value);
    case 'contains':
      return String(actual ?? '')
        .toLowerCase()
        .includes(String(value ?? '').toLowerCase());
    case 'startsWith':
      return String(actual ?? '')
        .toLowerCase()
        .startsWith(String(value ?? '').toLowerCase());
    case 'gt':
      return compare(actual, value) > 0;
    case 'gte':
      return compare(actual, value) >= 0;
    case 'lt':
      return compare(actual, value) < 0;
    case 'lte':
      return compare(actual, value) <= 0;
    case 'in':
      return Array.isArray(value) && value.some((v) => looseEquals(actual, v));
    case 'isEmpty':
      return actual === undefined || actual === null || actual === '';
    case 'isNotEmpty':
      return !(actual === undefined || actual === null || actual === '');
    default:
      return false;
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === toBoolean(b);
  }
  if (typeof a === 'number' && typeof b !== 'number') return a === Number(b);
  return a === b || String(a ?? '') === String(b ?? '');
}

function toBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return v === 'true' || v === '1' || v === 1;
}

function compare(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function compareStringKey(a: unknown, b: unknown): number {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Multi-key comparator from a list of sort clauses. */
export function compareBySort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sort: SortClause[],
): number {
  for (const s of sort) {
    const cmp =
      s.field === '_id'
        ? compareStringKey(a[s.field], b[s.field])
        : compare(a[s.field], b[s.field]);
    if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}
