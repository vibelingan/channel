import { configuredWebsiteDelivery } from './runtime-delivery.ts';
export { configuredWebsiteDelivery } from './runtime-delivery.ts';

export async function reconcileWebsiteOnce(env: Record<string, string | undefined> = process.env) {
  const worker = configuredWebsiteDelivery(env);
  return worker ? worker.tick() : { state: 'disabled', wrapped: false, results: [] };
}
if (require.main === module) {
  reconcileWebsiteOnce()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Sales website reconciliation failed\n');
      process.exitCode = 1;
    });
}
