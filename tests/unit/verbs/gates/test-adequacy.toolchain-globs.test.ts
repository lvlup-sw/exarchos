/**
 * `check_test_adequacy` must classify test files with the test layout of the resolved toolchain.
 * The co-located default globs do not match the pytest layout `tests/test_*.py`. With them, every Python test counts as source, and the probe reports `no-new-tests`.
 * The test dispatches through `handleOrchestrate` and injects `runTests`, so no real pytest runs. Git runs on a real temp repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

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

describe('check_test_adequacy toolchain test-glob threading (FIX-3)', () => {
  const cleanups: Array<() => void> = [];

  /** Cleanup is best effort. */
  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  /**
   * The Python repo keeps its tests under `tests/test_*.py`, which the co-located defaults do not match.
   * The injected `runTests` fails on the reverted source, so the probe passes. The test checks only the classification.
   */
  it(
    'CheckTestAdequacy_PythonTestsLayout_ClassifiedAsTest',
    async () => {
      const repoRoot = await initRepo('test-adequacy-pyglob-');
      cleanups.push(() => rmrf(repoRoot));

      writeFileSync(path.join(repoRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n');
      mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      writeFileSync(path.join(repoRoot, 'src', 'calc.py'), 'def value():\n    return 1\n');
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'base', '-q']);

      await git(repoRoot, ['checkout', '-b', 'feature/py', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.py'), 'def value():\n    return 2\n');
      mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
      writeFileSync(
        path.join(repoRoot, 'tests', 'test_foo.py'),
        'from src.calc import value\n\n\ndef test_value():\n    assert value() == 2\n',
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat + test', '-q']);

      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-pyglob-state-'));
      cleanups.push(() => rmrf(stateDir));
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();
      const ctx = withTrustedCaller(
        { stateDir, eventStore, enableTelemetry: false } as DispatchContext,
      );

      const runTests = async () => ({ passed: false, output: 'red on revert' });

      const result = await orchestrate(
        {
          action: 'check_test_adequacy',
          featureId: 'feat-pyglob',
          taskId: 'T-py',
          branch: 'feature/py',
          repoRoot,
          baseBranch: 'main',
          runTests,
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const data = result.data as { probedTests: string[]; discriminant?: string };
      expect(data.discriminant).not.toBe('no-new-tests');
      expect(data.probedTests).toEqual(expect.arrayContaining(['tests/test_foo.py']));
    },
    120_000,
  );
});

/**
 * These tests invoke the composite handler DIRECTLY, bypassing `dispatch()`.
 * The durable-evidence gates need the ambient trusted dispatch scope
 * (`TRUSTED_CALLER_REQUIRED` without it) and a started workflow with an active
 * phase attempt for evidence to bind to (`ACTIVE_PHASE_ATTEMPT_REQUIRED`).
 */
const seededWorkflows = new Set<string>();

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
