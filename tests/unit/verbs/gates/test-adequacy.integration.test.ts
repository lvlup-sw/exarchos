// Acceptance tests for `check_test_adequacy`. They dispatch through the composite `handleOrchestrate`
// router against a real git fixture repo in a temp directory. The kill probe must tell a real test
// from a vacuous one.
// A real test fails when the source change is reverted, so the probe sees red and passes. A vacuous
// test stays green on the revert, so the probe fails with `redObserved: false`.
// `test-adequacy.test.ts` holds the unit tests for the split, the snapshot and restore, and the probe.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';


function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/**
 * Writes a small node project whose tests run with `node --test`, so the temp repo needs no install.
 * The `test:run` script gives the npm tier of the resolver a runnable command. The base source
 * returns 1, and each task diff changes it to 2.
 */
async function writeBaseProject(repoRoot: string): Promise<void> {
  writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        private: true,
        scripts: { 'test:run': 'node --test', test: 'node --test' },
      },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 1;\n}\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base: project scaffold', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return withTrustedCaller({ stateDir, eventStore, enableTelemetry: false } as DispatchContext);
}

interface AdequacyData {
  passed: boolean;
  redObserved: boolean;
  restoredClean: boolean;
  probedTests: string[];
  discriminant?: string;
}

/**
 * Runs real `npm` and git in a temp fixture. On Windows, `runCommandSync` starts the `npm` `.cmd` shim
 * with `shell: true`, because `execFile` cannot start a `.cmd` file on Node 20.12.2 and later.
 */
describe('check_test_adequacy acceptance (kill probe through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  async function dispatch(
    repoRoot: string,
    branch: string,
  ): Promise<{ success: boolean; data: AdequacyData }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = makeCtx(stateDir, eventStore);
    const result = await orchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-adequacy',
        taskId: 'T-01',
        branch,
        repoRoot,
        baseBranch: 'main',
      },
      ctx,
    );
    return result as { success: boolean; data: AdequacyData };
  }

  /**
   * The task diff changes the source and adds a test that asserts `value() === 2`. The probe must see
   * red on the revert and pass.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_RealTest_PassesProbe',
    async () => {
      const repoRoot = await initRepo('test-adequacy-real-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/real', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          "import { value } from '../../orchestrate/calc.js';",
          '',
          "test('value is 2', () => {",
          '  assert.strictEqual(value(), 2);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/real');

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.redObserved).toBe(true);
      expect(data.restoredClean).toBe(true);
      expect(data.probedTests).toEqual(expect.arrayContaining(['src/calc.test.js']));
      expect(data.discriminant).toBeUndefined();
    },
    120_000,
  );

  /**
   * The task diff changes the source and adds a test that asserts nothing. The test stays green on the
   * revert, so the probe fails. The tool call still succeeds with an advisory carrier.
   */
  it(
    'HandleOrchestrate_CheckTestAdequacy_AssertNothingTest_FailsProbe',
    async () => {
      const repoRoot = await initRepo('test-adequacy-vacuous-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/vacuous', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          '',
          "test('vacuous', () => {",
          '  assert.strictEqual(true, true);',
          '});',
          '',
        ].join('\n'),
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with vacuous test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/vacuous');

      expect(success).toBe(true);
      expect(data.passed).toBe(false);
      expect(data.redObserved).toBe(false);
      expect(data.restoredClean).toBe(true);
    },
    120_000,
  );
});

/** One key for each state directory and feature id, so each new store gets one seed. */
const seededWorkflows = new Set<string>();

/**
 * Calls the composite handler directly, not through `dispatch()`. It recreates the trusted dispatch
 * scope, because without it the gate runner refuses with `TRUSTED_CALLER_REQUIRED`. It also seeds a
 * started workflow with an active phase attempt, which the gate evidence binds to.
 */
async function orchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<Awaited<ReturnType<typeof handleOrchestrate>>> {
  const featureId = typeof args['featureId'] === 'string' ? args['featureId'] : undefined;
  if (featureId !== undefined) {
    const key = `${ctx.stateDir}\0${featureId}`;
    if (!seededWorkflows.has(key)) {
      seededWorkflows.add(key);
      await seedActivePhaseAttempt(ctx.eventStore, featureId);
    }
  }
  return runAsTrustedCaller(ctx.stateDir, () => handleOrchestrate(args, ctx));
}
