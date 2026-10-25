import { identity } from '../release/input.mjs';

const receipt = (step) => ({
  status: 'verified',
  executionId: step.executionId,
  planSha256: step.planSha256,
  operationId: step.operationId,
  intentHash: step.intentHash,
  subject: step.verifySubject,
  expectedHash: step.afterHash,
  observedHash: step.afterHash,
  terminal: true,
});

/** The drill uses the production journal protocol, with its own physical collections. */
export async function journalDummyDelivery({
  coordinator,
  owner,
  runId,
  composition,
  adopt = false,
  write,
  verify,
}) {
  const guard = await coordinator.acquire(owner);
  const hash = identity(composition);
  let step;
  let started = false;
  try {
    await coordinator.startRun({
      guard,
      runId,
      scopeKey: 'site',
      kind: adopt ? 'adopt' : 'publish',
      composition,
      ...(adopt ? {} : { deliveredComponents: ['function:seo-release-dummy'] }),
      plan: { planSha256: hash, acceptanceHash: hash, stepCount: adopt ? 1 : 2 },
    });
    started = true;
    if (!adopt) {
      const current = await coordinator.status({ scopeKey: 'site' });
      const source = await coordinator.runStatus(current.scope.baseline.sourceRunId);
      step = await coordinator.beginStep({
        guard,
        runId,
        stepId: 'write-dummy',
        component: 'function:seo-release-dummy',
        kind: 'write',
        beforeHash: source.composition['function:seo-release-dummy'].contentSha256,
        afterHash: composition['function:seo-release-dummy'].contentSha256,
        subject: 'code:seo-release-dummy',
        verifySubject: 'ready:seo-release-dummy',
        executionId: `${runId}:write`,
      });
      await write(guard);
      await verify();
      await coordinator.confirmStep({ guard, runId, stepId: step.stepId, receipt: receipt(step) });
      step = null;
    }
    await verify();
    step = await coordinator.beginStep({
      guard,
      runId,
      stepId: 'accept-dummy',
      component: 'scope',
      kind: 'accept',
      beforeHash: hash,
      afterHash: hash,
      subject: 'accept',
      verifySubject: 'accept',
      executionId: `${runId}:accept`,
    });
    await coordinator.confirmStep({ guard, runId, stepId: step.stepId, receipt: receipt(step) });
    step = null;
    return await coordinator.commitRun({ guard, runId, changeSetRef: `isolated-dummy:${hash}` });
  } catch (error) {
    if (step)
      await coordinator
        .markUnknown({
          guard,
          runId,
          stepId: step.stepId,
          reason: 'Read back the isolated function before further writes',
        })
        .catch(() => {});
    else if (started)
      await coordinator
        .failRun({ guard, runId, reason: 'Isolated dummy verification failed' })
        .catch(() => {});
    throw error;
  } finally {
    await coordinator.release(guard).catch(() => {});
  }
}
