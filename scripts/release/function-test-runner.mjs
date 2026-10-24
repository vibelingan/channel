import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkFunctionArchive } from './function-archive.mjs';
import { functionRecoveryContext } from './function-compatibility.mjs';
import { readObject, sha256 } from './input.mjs';

const kinds = ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'];
/** Only tests pinned in the executor checkout may run; payloads cannot supply test scripts or commands. */
export function runFunctionCompatibilityTests({
  root,
  directory,
  baselines,
  observation,
  policy,
  now = Date.now(),
}) {
  const components = [];
  const reasons = [];
  const temp = mkdtempSync(join(tmpdir(), 'function-contract-tests-'));
  try {
    for (const baseline of baselines) {
      const context = functionRecoveryContext({
        target: observation.target,
        baseline,
        observation,
        now,
      });
      const specs = policy.compatibilitySuites.filter((x) => x.name === baseline.name);
      if (
        specs.length !== kinds.length ||
        kinds.some((kind) => specs.filter((x) => x.kind === kind).length !== 1)
      ) {
        reasons.push(`MISSING_REVIEWED_SUITES:${baseline.name}`);
        continue;
      }
      const bytes = readObject(directory, baseline.packagePath);
      if (sha256(bytes) !== baseline.sha256)
        throw new Error('Baseline package changed before compatibility tests');
      checkFunctionArchive(bytes);
      const packagePath = join(temp, `${baseline.name}.zip`);
      writeFileSync(packagePath, bytes, { flag: 'wx', mode: 0o400 });
      const contextPath = join(temp, `${baseline.name}.json`);
      writeFileSync(
        contextPath,
        JSON.stringify({ context: context.body, baselinePackagePath: packagePath }),
        { flag: 'wx', mode: 0o600 },
      );
      const suites = specs.map((spec) => {
        if (
          !/^scripts\/compatibility\/[A-Za-z0-9_/-]+\.test\.mjs$/.test(spec.testRef) ||
          !Array.isArray(spec.requiredTests) ||
          !spec.requiredTests.length ||
          spec.requiredTests.length > 256 ||
          new Set(spec.requiredTests).size !== spec.requiredTests.length ||
          spec.requiredTests.some((x) => typeof x !== 'string' || !x || x.length > 512) ||
          sha256(readObject(root, spec.testRef, 1048576)) !== spec.suiteSha256
        )
          throw new Error('Compatibility suite is not pinned to reviewed source');
        let output;
        try {
          output = execFileSync(
            process.execPath,
            ['--test', '--test-reporter=tap', resolve(root, spec.testRef)],
            {
              cwd: root,
              env: { PATH: process.env.PATH, RELEASE_COMPATIBILITY_CONTEXT: contextPath },
              encoding: 'utf8',
              timeout: 120000,
              maxBuffer: 4 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
        } catch {
          throw new Error('Compatibility suite execution failed');
        }
        const count = (key) =>
          Number(new RegExp(`^# ${key} ([0-9]+)$`, 'm').exec(output)?.[1] ?? Number.NaN);
        if (
          !(count('tests') > 0) ||
          count('pass') !== count('tests') ||
          ['fail', 'cancelled', 'skipped', 'todo'].some((key) => count(key) !== 0) ||
          /^not ok /m.test(output)
        )
          throw new Error('Compatibility suite did not pass every test');
        const names = [...output.matchAll(/^\s*# Subtest: (.+)$/gm)].map((x) => x[1]);
        if (spec.requiredTests.some((name) => names.filter((x) => x === name).length !== 1))
          throw new Error('Compatibility suite did not run every required named case');
        return {
          kind: spec.kind,
          suiteSha256: spec.suiteSha256,
          testRef: spec.testRef,
          totalTests: count('tests'),
          tests: spec.requiredTests.map((name) => ({ name, status: 'passed' })),
        };
      });
      const covered = (kind) => specs.find((x) => x.kind === kind).covers;
      components.push({
        name: baseline.name,
        contextSha256: context.sha256,
        suites,
        readerFormats: covered('reader'),
        writerFormats: covered('writer-preserves-unknown'),
        apiContracts: covered('api-clients'),
        preservesUnknownFields: true,
      });
    }
    return {
      schemaVersion: 1,
      purpose: 'function-compatibility-test-results',
      status: reasons.length ? 'manual-required' : 'passed',
      reasons,
      components,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
