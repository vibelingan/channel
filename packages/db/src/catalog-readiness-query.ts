import type { SortClause } from '@vibelingan-channel/shared';
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
  type CatalogReadiness,
  CatalogReadinessSchema,
} from '@vibelingan-channel/shared/catalog-preparation';

type Row = Record<string, unknown>;
interface Command {
  and(conditions: Row[]): Row;
  or(conditions: Row[]): Row;
  eq(value: unknown): unknown;
  in(values: unknown[]): unknown;
  expr(expression: Row): Row;
}
const record = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null;

/** Query only the server-written summary. Full content validation still owns readiness. */
export function matchesCatalogReadiness(product: Row, scope: CatalogReadiness): boolean {
  CatalogReadinessSchema.parse(scope);
  if (scope === 'all') return true;
  const generation = product.catalogContentGeneration ?? 0;
  const validIdentity = typeof product._id === 'string' && product._id.length > 0;
  const validGeneration =
    typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0;
  const current = (summary: Row | null, schema: string, state: string) =>
    validIdentity &&
    validGeneration &&
    summary !== null &&
    product.catalogPreparationPolicy === CATALOG_PREPARATION_POLICY &&
    product.catalogPreparationState === state &&
    summary.schemaVersion === schema &&
    summary.productId === product._id &&
    summary.contentGeneration === generation &&
    summary.policyVersion === CATALOG_PREPARATION_POLICY;
  const report = record(product.catalogPreparationReport);
  const seal = record(report?.seal);
  const ready =
    current(report, 'catalog-preparation-report-v2', 'ready') &&
    report?.state === 'ready' &&
    report.previewReady === true &&
    report.mediaReady === true &&
    seal?.kind === 'catalog-preparation-ready-seal-v1' &&
    seal.mediaPolicyVersion === CATALOG_MEDIA_SEAL_POLICY &&
    seal.pixelPolicyVersion === CATALOG_PIXEL_POLICY;
  const blocked =
    current(report, 'catalog-preparation-report-v2', 'blocked') && report?.state === 'blocked';
  const preparing =
    (current(report, 'catalog-preparation-report-v2', 'preparing') &&
      report?.state === 'preparing' &&
      report.previewReady === true &&
      report.mediaReady === false) ||
    current(
      record(product.catalogPreparationRequest),
      'catalog-preparation-request-v1',
      'checking',
    );
  if (scope === 'normal') return product.published === true || ready;
  if (product.published === true) return false;
  if (scope === 'issues') return blocked;
  if (scope === 'preparing') return preparing;
  return !ready && !blocked && !preparing;
}

/** Same bounded summary predicate before native count, sorting and pagination; no source joins. */
export function catalogReadinessWhere(command: Command, scope: CatalogReadiness): Row {
  CatalogReadinessSchema.parse(scope);
  if (scope === 'all') return command.expr({ $eq: [true, true] });
  const eq = (left: unknown, right: unknown): Row => ({ $eq: [left, right] });
  const and = (...parts: Row[]): Row => ({ $and: parts });
  const or = (...parts: Row[]): Row => ({ $or: parts });
  const not = (part: Row): Row => ({ $not: [part] });
  const generation = { $ifNull: ['$catalogContentGeneration', 0] };
  // Guard numeric operators with cond: malformed stored values must not abort the entire page.
  const validGeneration = {
    $cond: [
      { $in: [{ $type: generation }, ['int', 'long', 'double', 'decimal']] },
      and(
        { $gte: [generation, 0] },
        { $lte: [generation, Number.MAX_SAFE_INTEGER] },
        eq({ $mod: [generation, 1] }, 0),
      ),
      false,
    ],
  };
  const current = (field: string, schema: string, state: string): Row =>
    and(
      validGeneration,
      eq({ $type: '$_id' }, 'string'),
      not(eq('$_id', '')),
      eq('$catalogPreparationPolicy', CATALOG_PREPARATION_POLICY),
      eq('$catalogPreparationState', state),
      eq(`$${field}.schemaVersion`, schema),
      eq(`$${field}.productId`, '$_id'),
      eq(`$${field}.contentGeneration`, generation),
      eq(`$${field}.policyVersion`, CATALOG_PREPARATION_POLICY),
    );
  const report = (state: string) =>
    and(
      current('catalogPreparationReport', 'catalog-preparation-report-v2', state),
      eq('$catalogPreparationReport.state', state),
    );
  const ready = and(
    report('ready'),
    eq('$catalogPreparationReport.previewReady', true),
    eq('$catalogPreparationReport.mediaReady', true),
    eq('$catalogPreparationReport.seal.kind', 'catalog-preparation-ready-seal-v1'),
    eq('$catalogPreparationReport.seal.mediaPolicyVersion', CATALOG_MEDIA_SEAL_POLICY),
    eq('$catalogPreparationReport.seal.pixelPolicyVersion', CATALOG_PIXEL_POLICY),
  );
  const blocked = report('blocked');
  const preparing = or(
    and(
      report('preparing'),
      eq('$catalogPreparationReport.previewReady', true),
      eq('$catalogPreparationReport.mediaReady', false),
    ),
    current('catalogPreparationRequest', 'catalog-preparation-request-v1', 'checking'),
  );
  const published = eq('$published', true);
  const expressions = {
    normal: or(published, ready),
    issues: and(not(published), blocked),
    preparing: and(not(published), preparing),
    unchecked: and(not(published), not(or(ready, blocked, preparing))),
  };
  const expression = command.expr(expressions[scope]);
  if (scope === 'unchecked') return expression;
  // Simple indexable clauses narrow candidates; expr enforces scalar and generation equality.
  const state = scope === 'normal' ? 'ready' : scope === 'issues' ? 'blocked' : null;
  const summary = {
    catalogPreparationPolicy: command.eq(CATALOG_PREPARATION_POLICY),
    catalogPreparationState: state ? command.eq(state) : command.in(['checking', 'preparing']),
  };
  return command.and([
    scope === 'normal' ? command.or([{ published: command.eq(true) }, summary]) : summary,
    expression,
  ]);
}

export function catalogReadinessSort(sort: readonly SortClause[] | undefined): SortClause[] {
  const primary: SortClause[] =
    sort && sort.length > 0 ? [...sort] : [{ field: 'createdAt', dir: 'desc' }];
  return primary.some((clause) => clause.field === '_id')
    ? primary
    : [...primary, { field: '_id', dir: 'asc' }];
}
