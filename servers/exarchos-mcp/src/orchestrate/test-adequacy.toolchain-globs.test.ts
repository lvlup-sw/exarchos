// ─── check_test_adequacy: toolchain test-glob threading (FIX-3) ───────────────
//
// `test-adequacy-handler` never populated `ProbeArgs.testGlobs`, so `splitHunks`
// always used the co-located defaults (`**/*.test.*`, `**/*.spec.*`,
// `**/__tests__/**`). A python repo whose tests live under `tests/test_*.py`
// (NOT `*.test.*`) had EVERY test misclassified as source → spurious
// `no-new-tests`. FIX-3 threads the resolved toolchain's test-file layout into
// the probe so `tests/test_foo.py` is classified as a test for a python repo.
//
// Dispatched THROUGH `handleOrchestrate`; `runTests` is injected so no real
// pytest is required, and `defaultGitExec` runs against a real temp-dir repo.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../test-helpers/trusted-context.js';

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function initRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

describe('check_test_adequacy toolchain test-glob threading (FIX-3)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'CheckTestAdequacy_PythonTestsLayout_ClassifiedAsTest',
    async () => {
      // Python-marker repo: tests live under `tests/test_*.py`, the pytest layout
      // — which the co-located defaults do NOT match.
      const repoRoot = initRepo('test-adequacy-pyglob-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

      writeFileSync(path.join(repoRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n');
      mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      writeFileSync(path.join(repoRoot, 'src', 'calc.py'), 'def value():\n    return 1\n');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base', '-q']);

      // Task diff: change source AND add a python test under tests/.
      git(repoRoot, ['checkout', '-b', 'feature/py', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.py'), 'def value():\n    return 2\n');
      mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
      writeFileSync(
        path.join(repoRoot, 'tests', 'test_foo.py'),
        'from src.calc import value\n\n\ndef test_value():\n    assert value() == 2\n',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat + test', '-q']);

      const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-pyglob-state-'));
      cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
      const eventStore = new EventStore(stateDir);
      await eventStore.initialize();
      const ctx = withTrustedCaller(
        { stateDir, eventStore, enableTelemetry: false } as DispatchContext,
      );

      // Inject runTests so no real pytest runs — report "failed on reverted source"
      // to make the probe pass; we only care about CLASSIFICATION here.
      const runTests = async () => ({ passed: false, output: 'red on revert' });

      const result = await orchestrate(
        {
          action: 'check_test_adequacy',
          featureId: 'feat-pyglob',
          taskId: 'T-py',
          branch: 'feature/py',
          repoRoot,
          runTests,
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const data = result.data as { probedTests: string[]; discriminant?: string };
      // The python test under tests/ must be classified as a test (NOT
      // no-new-tests). Before FIX-3 this misclassified → discriminant
      // 'no-new-tests' and an empty probedTests.
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
