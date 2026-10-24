import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertErrorDocument } from '../hosting-contract.mjs';
import { verifyRetainedHostingFiles } from '../hosting-delta.mjs';
import { recoveryStateIdentity } from '../hosting-recovery.mjs';
import { fetchFully } from '../smoke-http.mjs';
import {
  hostingBatchBeforeHash,
  hostingBatchHash,
  hostingRemovalHash,
  mapHostingBounded,
  siteRemovalBatches,
  siteUploadBatches,
} from './hosting-batches.mjs';
import {
  configurationHash,
  configurationStateHash,
  errorDocumentPath,
  validateConfigurationChange,
} from './hosting-configuration.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import {
  articleMediaFile,
  assertHostingPath,
  checkEntries,
  freeze,
  identity,
  isSitemap,
  limits,
  readHostingObject,
  sha256,
} from './input.mjs';

export function hostingCoordinatorPlan(plan, configurationPlan) {
  validatePlan(plan, configurationPlan);
  return freeze({
    planSha256: identity({ hostingPlan: plan.planSha256, configurationPlan }),
    acceptanceHash: plan.stateSha256,
    stepCount:
      (siteUploadBatches(plan)?.length ?? plan.uploads.length) +
      (siteRemovalBatches(plan)?.length ?? plan.deletes.length) +
      configurationPlan.changes.length +
      1,
  });
}

/** A2 callbacks and B1 intents share one fixed target. This does not expose a deployment entrypoint. */
export function createHostingRecoveryAdapters({
  plan: input,
  directory,
  configurationPlan: configurationInput,
  coordinator,
  guard: inputGuard,
  runId,
  provider: inputProvider,
  request = fetchFully,
  errorDocument: inputErrorDocument,
  signal,
  heartbeatMs = 60_000,
  operationTimeoutMs = 120_000,
  pollIntervalMs = 1000,
  requestTimeoutMs = 15_000,
}) {
  const plan = freeze(structuredClone(input));
  const configurationPlan = freeze(structuredClone(configurationInput));
  const guard = freeze(structuredClone(inputGuard));
  const provider = Object.freeze({ ...inputProvider });
  const errorDocument = inputErrorDocument ? freeze(structuredClone(inputErrorDocument)) : null;
  const entries = new Map(plan.uploads.map((entry) => [entry.path, entry]));
  const descriptor = hostingCoordinatorPlan(plan, configurationPlan);
  if (
    plan.deletes.length &&
    errorDocument?.path !== configurationPlan.after.website.WebsiteConfiguration.ErrorDocument?.Key
  )
    throw new Error('Pinned error document required before deletion');
  if (identity(provider.target) !== identity(plan.target))
    throw new Error('Hosting provider target differs from plan');
  for (const [name, value, min, max] of [
    ['heartbeat', heartbeatMs, 10, 60_000],
    ['operation timeout', operationTimeoutMs, 20, 900_000],
    ['poll interval', pollIntervalMs, 1, 10_000],
    ['request timeout', requestTimeoutMs, 1, 120_000],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid hosting ${name}`);
  const pending = new Map();
  let prepared = false;
  const context = (value, subject, hash) => {
    if (
      value?.planSha256 !== plan.planSha256 ||
      value.subject !== subject ||
      value.expectedHash !== hash ||
      typeof value.executionId !== 'string' ||
      !value.executionId
    )
      throw new Error('Hosting callback context differs from plan');
  };
  const kernelReceipt = (ctx, operationId, extra = {}) => ({ ...ctx, operationId, ...extra });
  const ledgerReceipt = (step, status, extra = {}) => ({
    status,
    executionId: step.executionId,
    planSha256: step.planSha256,
    operationId: step.operationId,
    intentHash: step.intentHash,
    subject: status === 'submitted' ? step.subject : step.verifySubject,
    expectedHash: step.afterHash,
    observedHash: step.afterHash,
    terminal: status === 'verified',
    ...extra,
  });
  const object = (entry) => {
    const allowed = entries.get(entry.path);
    if (!allowed || identity(allowed) !== identity(entry))
      throw new Error('Unplanned hosting object');
    return allowed;
  };
  const begin = async (
    ctx,
    subject,
    verifySubject,
    beforeHash,
    afterHash,
    kind,
    activeSignal,
    batch = {},
  ) => {
    activeSignal.throwIfAborted();
    const step = await coordinator.beginStep({
      guard,
      runId,
      stepId: identity({ executionId: ctx.executionId, subject }),
      component: kind === 'accept' ? 'scope' : 'static',
      kind,
      beforeHash,
      afterHash,
      subject,
      verifySubject,
      executionId: ctx.executionId,
      ...batch,
    });
    if (activeSignal.aborted) {
      await unknown(step);
      activeSignal.throwIfAborted();
    }
    return step;
  };
  const unknown = async (step) => {
    if (!step) return;
    try {
      await coordinator.markUnknown({
        guard,
        runId,
        stepId: step.stepId,
        reason: 'Hosting outcome requires readback before another write',
      });
    } catch {
      /* If the update fails, the persisted intent/submission still blocks another write. */
    }
  };
  const verify = async (entry, path, status, activeSignal) =>
    verifyHostingObject({
      target: plan.target,
      entry,
      path,
      expectedStatus: status,
      request,
      signal: activeSignal,
      timeoutMs: requestTimeoutMs,
    });
  async function ready(activeSignal) {
    const run = await coordinator.runStatus(runId);
    const state = await coordinator.status({ scopeKey: run.scopeKey });
    activeSignal.throwIfAborted();
    if (
      state.state !== 'leased' ||
      state.targetId !== guard.targetId ||
      state.target?.target.envId !== plan.target.envId ||
      state.target?.target.siteOrigin !== plan.target.site
    )
      throw new Error('Hosting lease target differs from provider target');
    if (
      run.state !== 'RUNNING' ||
      identity(run.plan) !== identity(descriptor) ||
      identity(run.scope) !== identity(plan.scope) ||
      !run.deliveredComponents.includes('static')
    )
      throw new Error('Hosting plan differs from coordinated run');
    if (!prepared) {
      const current = await provider.readConfiguration();
      activeSignal.throwIfAborted();
      if (configurationStateHash(current) !== configurationStateHash(configurationPlan.before))
        throw new Error('Hosting configuration changed before first effect');
      prepared = true;
    }
  }
  async function beforeHash(path, activeSignal) {
    const publicPath = path === 'index.html' ? '/' : `/${path.replace(/\/index\.html$/, '/')}`;
    const response = await request('GET', new URL(publicPath, plan.target.site).href, {
      signal: activeSignal,
      redirect: 'error',
      timeoutMs: requestTimeoutMs,
      maxBytes: limits.fileBytes + 1,
      headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' },
    });
    activeSignal.throwIfAborted();
    if (response.status === 404) {
      assertErrorDocument(response.body);
      return 'absent';
    }
    if (response.status !== 200) throw new Error('Cannot establish hosting before state');
    return sha256(response.body);
  }
  async function leased(callback, timeoutMs = operationTimeoutMs) {
    signal?.throwIfAborted();
    await coordinator.renew(guard);
    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        await coordinator.renew(guard);
      } catch {
        controller.abort(new Error('Hosting lease lost'));
      } finally {
        renewing = false;
      }
    }, heartbeatMs);
    const deadline = setTimeout(
      () =>
        controller.abort(new Error('Hosting operation timed out; cloud work may still be running')),
      timeoutMs,
    );
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(activeSignal.reason);
      activeSignal.addEventListener('abort', onAbort, { once: true });
      if (activeSignal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([
        aborted,
        (async () => {
          await ready(activeSignal);
          const value = await callback(activeSignal);
          activeSignal.throwIfAborted();
          return value;
        })(),
      ]);
      return result;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      activeSignal.removeEventListener('abort', onAbort);
    }
  }
  async function verifyRetained() {
    if (!plan.retained?.length) return;
    if (typeof provider.readInventory !== 'function')
      throw new Error('Authenticated retained-object inventory required.');
    verifyRetainedHostingFiles(plan.retained, await provider.readInventory());
  }
  const checkedBatch = (inputEntries) => {
    const batch = freeze(structuredClone(inputEntries));
    batch.forEach(object);
    if (!siteUploadBatches(plan)?.some((allowed) => identity(allowed) === identity(batch)))
      throw Error('Unplanned hosting batch');
    return batch;
  };
  const acceptanceTimeoutMs = plan.delivery
    ? Math.min(
        900_000,
        Math.max(
          operationTimeoutMs,
          (Math.ceil(plan.uploads.length / 4) + Math.ceil(plan.deletes.length / 4)) *
            requestTimeoutMs *
            3 +
            30_000,
        ),
      )
    : operationTimeoutMs;
  const api = {
    verifyRetained,
    async uploadBatch(inputEntries, inputContext) {
      const batch = checkedBatch(inputEntries);
      const ctx = freeze(structuredClone(inputContext));
      const hash = hostingBatchHash(batch);
      context(ctx, `upload-batch:${hash}`, hash);
      const bodies = batch.map((entry) => {
        const body = readHostingObject(directory, entry);
        if (body.length !== entry.bytes || sha256(body) !== entry.sha256)
          throw Error('Hosting artifact changed');
        return body;
      });
      let step;
      try {
        return await leased(async (activeSignal) => {
          const members = await mapHostingBounded(batch, 4, async (entry) => ({
            ...entry,
            beforeHash: await beforeHash(entry.path, activeSignal),
          }));
          step = await begin(
            ctx,
            ctx.subject,
            `read-batch:${hash}`,
            hostingBatchBeforeHash(members),
            hash,
            'write',
            activeSignal,
            { members },
          );
          if (step.state !== 'verified') {
            await mapHostingBounded(batch, 4, async (entry, index) => {
              activeSignal.throwIfAborted();
              const result = await provider.upload(entry.path, bodies[index], {
                signal: activeSignal,
              });
              if (result?.terminal !== true) throw Error('Hosting upload is not terminal');
            });
            activeSignal.throwIfAborted();
            await coordinator.recordSubmitted({
              guard,
              runId,
              stepId: step.stepId,
              receipt: ledgerReceipt(step, 'submitted'),
            });
          }
          pending.set(step.operationId, step);
          return kernelReceipt(ctx, step.operationId, { status: 'submitted' });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async verifyBatch(inputEntries, inputContext) {
      const batch = checkedBatch(inputEntries);
      const ctx = freeze(structuredClone(inputContext));
      const hash = hostingBatchHash(batch);
      context(ctx, `read-batch:${hash}`, hash);
      const step = pending.get(ctx.operationId);
      if (!step || step.executionId !== ctx.executionId || step.verifySubject !== ctx.subject)
        throw Error('No matching submitted hosting batch');
      try {
        return await leased(async (activeSignal) => {
          const evidence = await mapHostingBounded(batch, 4, (entry) =>
            verify(entry, entry.path, 200, activeSignal),
          );
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'verified', { evidence }),
          });
          return kernelReceipt(ctx, step.operationId, { status: 'verified', observedHash: hash });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async upload(inputEntry, inputContext) {
      const entry = freeze(structuredClone(inputEntry));
      const ctx = freeze(structuredClone(inputContext));
      object(entry);
      context(ctx, `upload:${entry.path}`, entry.sha256);
      const body = readHostingObject(directory, entry);
      if (body.length !== entry.bytes || sha256(body) !== entry.sha256)
        throw new Error('Hosting artifact changed');
      let step;
      try {
        return await leased(async (activeSignal) => {
          const before = await beforeHash(entry.path, activeSignal);
          step = await begin(
            ctx,
            ctx.subject,
            `read:${entry.path}`,
            before,
            entry.sha256,
            'write',
            activeSignal,
          );
          if (step.state === 'verified') {
            pending.set(step.operationId, step);
            return kernelReceipt(ctx, step.operationId, { status: 'submitted' });
          }
          activeSignal.throwIfAborted();
          const result = await provider.upload(entry.path, body, { signal: activeSignal });
          activeSignal.throwIfAborted();
          if (result?.terminal !== true) throw new Error('Hosting upload is not terminal');
          await coordinator.recordSubmitted({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'submitted', result),
          });
          pending.set(step.operationId, step);
          return kernelReceipt(ctx, step.operationId, { status: 'submitted' });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async verify(inputEntry, inputContext) {
      const entry = freeze(structuredClone(inputEntry));
      const ctx = freeze(structuredClone(inputContext));
      object(entry);
      context(ctx, `read:${entry.path}`, entry.sha256);
      const step = pending.get(ctx.operationId);
      if (!step || step.executionId !== ctx.executionId || step.verifySubject !== ctx.subject)
        throw new Error('No matching submitted hosting intent');
      try {
        return await leased(async (activeSignal) => {
          const observed = await verify(entry, entry.path, 200, activeSignal);
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'verified', { evidence: observed }),
          });
          return kernelReceipt(ctx, step.operationId, {
            status: 'verified',
            observedHash: observed.sha256,
          });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async removeBatch(inputPaths, inputContext) {
      const paths = freeze(structuredClone(inputPaths));
      if (
        !siteRemovalBatches(plan)?.some((batch) => identity(batch) === identity(paths)) ||
        !errorDocument
      )
        throw Error('Unplanned hosting removal batch');
      const ctx = freeze(structuredClone(inputContext));
      const hash = hostingRemovalHash(paths);
      context(ctx, `remove-batch:${hash}`, hash);
      let step;
      try {
        return await leased(async (activeSignal) => {
          const removals = await mapHostingBounded(paths, 4, async (path) => ({
            path,
            beforeHash: await beforeHash(path, activeSignal),
          }));
          step = await begin(
            ctx,
            ctx.subject,
            ctx.subject,
            hostingBatchBeforeHash(removals),
            hash,
            'write',
            activeSignal,
            { removals },
          );
          if (step.state !== 'verified') {
            await mapHostingBounded(paths, 4, async (path) => {
              activeSignal.throwIfAborted();
              const result = await provider.remove(path, { signal: activeSignal });
              if (result?.terminal !== true) throw Error('Hosting delete is not terminal');
            });
            activeSignal.throwIfAborted();
            await coordinator.recordSubmitted({
              guard,
              runId,
              stepId: step.stepId,
              receipt: ledgerReceipt(step, 'submitted'),
            });
          }
          const evidence = await mapHostingBounded(paths, 4, (path) =>
            verify(errorDocument, path, 404, activeSignal),
          );
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'verified', { evidence }),
          });
          return kernelReceipt(ctx, step.operationId, { status: 'verified', observedHash: hash });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async remove(path, inputContext) {
      const ctx = freeze(structuredClone(inputContext));
      assertHostingPath(path);
      context(ctx, `remove:${path}`, 'absent');
      if (!plan.deletes.includes(path) || !errorDocument)
        throw new Error('Unplanned deletion or missing error document proof');
      let step;
      try {
        return await leased(async (activeSignal) => {
          const before = await beforeHash(path, activeSignal);
          step = await begin(
            ctx,
            ctx.subject,
            ctx.subject,
            before,
            'absent',
            'write',
            activeSignal,
          );
          activeSignal.throwIfAborted();
          const result = await provider.remove(path, { signal: activeSignal });
          activeSignal.throwIfAborted();
          if (result?.terminal !== true) throw new Error('Hosting delete is not terminal');
          await coordinator.recordSubmitted({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'submitted', result),
          });
          const observed = await verify(errorDocument, path, 404, activeSignal);
          activeSignal.throwIfAborted();
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'verified', { evidence: observed }),
          });
          return kernelReceipt(ctx, step.operationId, {
            status: 'verified',
            observedHash: 'absent',
          });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async configure(inputContext) {
      const ctx = freeze(structuredClone(inputContext));
      context(ctx, 'configure', plan.configurationSha256);
      let step;
      let operationId = randomUUID();
      try {
        return await leased(async (activeSignal) => {
          for (const [index, change] of configurationPlan.changes.entries()) {
            const current = await provider.readConfiguration();
            validateConfigurationChange({ change, current, target: plan.target });
            activeSignal.throwIfAborted();
            const subject = `configure:${index}:${change.kind}`;
            step = await begin(
              ctx,
              subject,
              subject,
              change.beforeHash,
              change.afterHash,
              'write',
              activeSignal,
            );
            operationId = step.operationId;
            activeSignal.throwIfAborted();
            const result = await provider.configure(change, { signal: activeSignal });
            activeSignal.throwIfAborted();
            if (result?.terminal !== true)
              throw new Error('Hosting configuration call did not settle');
            await coordinator.recordSubmitted({
              guard,
              runId,
              stepId: step.stepId,
              receipt: ledgerReceipt(step, 'submitted', result),
            });
            let stable = 0;
            while (stable < 2) {
              const observed = await provider.readConfiguration();
              activeSignal.throwIfAborted();
              stable = configurationStateHash(observed) === change.afterHash ? stable + 1 : 0;
              if (stable < 2) await delay(pollIntervalMs, undefined, { signal: activeSignal });
            }
            await coordinator.confirmStep({
              guard,
              runId,
              stepId: step.stepId,
              receipt: ledgerReceipt(step, 'verified'),
            });
            step = null;
          }
          const current = await provider.readConfiguration();
          if (configurationStateHash(current) !== configurationStateHash(configurationPlan.after))
            throw new Error('Final hosting configuration mismatch');
          return kernelReceipt(ctx, operationId, {
            status: 'verified',
            observedHash: plan.configurationSha256,
            rawConfigurationSha256: configurationHash(current),
            configurationStateSha256: configurationStateHash(current),
          });
        });
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
    async accept(inputContext) {
      const ctx = freeze(structuredClone(inputContext));
      context(ctx, 'accept', plan.stateSha256);
      await verifyRetained();
      let step;
      try {
        return await leased(async (activeSignal) => {
          step = await begin(
            ctx,
            'accept',
            'accept',
            plan.stateSha256,
            plan.stateSha256,
            'accept',
            activeSignal,
          );
          const files = await mapHostingBounded(
            plan.uploads,
            plan.delivery ? 4 : 1,
            async (entry) => {
              const observed = await verify(entry, entry.path, 200, activeSignal);
              return { ...entry, sha256: observed.sha256 };
            },
          );
          await mapHostingBounded(plan.deletes, plan.delivery ? 4 : 1, (path) =>
            verify(errorDocument, path, 404, activeSignal),
          );
          const config = await provider.readConfiguration();
          activeSignal.throwIfAborted();
          if (configurationStateHash(config) !== configurationStateHash(configurationPlan.after))
            throw new Error('Hosting configuration state changed');
          const observedHash = recoveryStateIdentity({
            ...plan,
            uploads: files,
            configurationSha256: plan.configurationSha256,
          });
          if (observedHash !== plan.stateSha256) throw new Error('Hosting acceptance changed');
          await coordinator.confirmStep({
            guard,
            runId,
            stepId: step.stepId,
            receipt: ledgerReceipt(step, 'verified', {
              rawConfigurationSha256: configurationHash(config),
              configurationStateSha256: configurationStateHash(config),
            }),
          });
          return kernelReceipt(ctx, step.operationId, { status: 'verified', observedHash });
        }, acceptanceTimeoutMs);
      } catch (error) {
        await unknown(step);
        throw error;
      }
    },
  };
  return Object.freeze(api);
}
function validatePlan(plan, configurationPlan) {
  checkEntries([...plan.uploads, ...(plan.retained ?? [])]);
  if (plan.uploads.some((entry) => entry.path === '404.html'))
    throw new Error('Reserved CloudBase fallback path');
  if (
    !Array.isArray(plan.deletes) ||
    plan.deletes.length > limits.files ||
    new Set(plan.deletes).size !== plan.deletes.length
  )
    throw new Error('Invalid hosting delete set');
  const paths = [...plan.uploads.map((entry) => entry.path), ...plan.deletes];
  if (new Set(paths).size !== paths.length) throw new Error('Upload and delete paths overlap');
  for (const path of paths) {
    assertHostingPath(path);
    if (/^(?:__auth\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/.test(path))
      throw new Error('Protected hosting path');
  }
  for (const path of plan.deletes)
    if (
      ['index.html', '404.html', errorDocumentPath].includes(path) ||
      !(
        path.endsWith('.html') ||
        articleMediaFile.test(path) ||
        isSitemap(path) ||
        ['robots.txt', 'seo-manifest.json', 'products/manifest.json'].includes(path)
      )
    )
      throw new Error('Unowned deletion type');
  if (plan.scope.kind === 'canary') {
    const prefix = plan.scope.prefix;
    if (
      typeof prefix !== 'string' ||
      !prefix.endsWith('/') ||
      prefix.startsWith('products/') ||
      prefix.startsWith('__auth/')
    )
      throw new Error('Invalid canary prefix');
    assertHostingPath(prefix.slice(0, -1));
    if (
      !plan.uploads.some((entry) => entry.path === `${prefix}index.html`) ||
      paths.some(
        (path) =>
          !path.startsWith(prefix) ||
          path.toLowerCase().endsWith('.xml') ||
          /(?:^|\/)(?:robots\.txt|seo-manifest\.json|manifest\.json|BingSiteAuth\.xml|google[a-z0-9]+\.html)$/.test(
            path,
          ),
      )
    )
      throw new Error('Hosting paths escape canary scope');
  } else if (plan.scope.kind !== 'site') throw new Error('Invalid hosting scope');

  const { planSha256, ...body } = plan;
  if (
    plan.schemaVersion !== 2 ||
    identity(body) !== planSha256 ||
    recoveryStateIdentity(plan) !== plan.stateSha256 ||
    identity(plan.target) !== identity(configurationPlan.target) ||
    configurationHash(configurationPlan.after) !== plan.configurationSha256
  )
    throw new Error('Invalid bound hosting plan');
  if (
    plan.scope.kind === 'canary' &&
    (configurationPlan.changes.length ||
      configurationHash(configurationPlan.before) !== plan.configurationSha256)
  )
    throw new Error('Canary cannot change global configuration');
  let current = configurationPlan.before;
  for (const change of configurationPlan.changes) {
    validateConfigurationChange({ change, current, target: plan.target });
    current = change.after;
  }
  if (configurationStateHash(current) !== configurationStateHash(configurationPlan.after))
    throw new Error('Incomplete configuration sequence');
}
