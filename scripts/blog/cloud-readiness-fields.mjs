const allowed = new Set([
  'EnvId',
  'PackageId',
  'PackageName',
  'PackageTitle',
  'UnitPrice',
  'ResourceLimit',
  'PayMode',
  'IsAutoRenew',
  'ExpireTime',
  'Status',
  'IsAlwaysFree',
  'IsOpenPostpay',
  'EnableOverrun',
  'StartTime',
  'EndTime',
  'AccountStartTime',
  'AccountEndTime',
  'ResourcePoint',
  'Module',
  'CreditsValue',
  'DeductValue',
  'PackageDeductValue',
  'ReportValue',
  'ResourceType',
  'MetricName',
  'Unit',
  'TotalCredits',
  'UsedCredits',
  'RemainCredits',
  'Balance',
  'RealBalance',
  'OweAmount',
  'CashAccountBalance',
  'FreezeAmount',
  'CreditBalance',
  'Cpu',
  'Mem',
  'MinNum',
  'MaxNum',
  'Port',
  'ServerName',
  'VersionName',
  'RunId',
  'Total',
  'Usage',
  'Used',
  'Remaining',
]);
export function safeFields(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const name = path ? `${path}.${key}` : key;
    if (
      key === 'Value' &&
      /(?:^|\.)Usages\.\d+\.MetricUsageDetail\.\d+\.Value$/.test(name) &&
      typeof item === 'number'
    )
      return [{ field: name, value: item }];
    if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof item))
      return [{ field: name, value: item }];
    if (item && typeof item === 'object') return safeFields(item, name);
    return [];
  });
}
