// ─── check_test_adequacy ACCEPTANCE — kill-probe through handleOrchestrate ────
//
// Verification-ladder slice 1, Bundle B2 (task 010). The end-to-end contract:
// dispatch `check_test_adequacy` through the composite `handleOrchestrate`
// router against a real temp-dir git fixture repo and prove the kill probe
// (mutation-testing-at-N=1) distinguishes a vacuous test from a real one.
//
//   • Real test  — a source change + a test that FAILS when the source is
//     reverted → the probe observes red on revert → `passed: true`.
//   • Vacuous test — a source change + an `expect(true).toBe(true)` assertion
//     that survives the revert → no red observed → `passed: false`,
//     `redObserved: false`.
//
// This file is the acceptance gate: it stays RED until task 014 registers the
// action + wires the dispatch branch. Per-handler/unit coverage of the split,
// snapshot/restore, and probe orchestration lives in test-adequacy.test.ts.
//
// The fixtures mirror the real-git idioms in local-git-merge.test.ts: a tiny
// node project committed on `main`, then a task diff committed on a feature
// branch. The probe resolves the test command from the project itself
// (resolveTestRuntime) so the fixture ships a runnable `npm test` — we use
// `node --test` so no install step is required inside the temp repo.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { rmrf } from '../test-helpers/temp-dir.js';

// ─── git fixture helpers ─────────────────────────────────────────────────────

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

/**
 * A tiny node project whose tests run via `node --test` (no install needed in
 * the temp repo). `package.json` declares a `test:run` script so the resolver
 * (npm tier) produces a runnable command, and `test` for good measure.
 */
function writeBaseProject(repoRoot: string): void {
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
  // Base source: a function returning 1. The task diff will change it to 2.
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 1;\n}\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base: project scaffold', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
}

interface AdequacyData {
  passed: boolean;
  redObserved: boolean;
  restoredClean: boolean;
  probedTests: string[];
  discriminant?: string;
}

// ─── tests ───────────────────────────────────────────────────────────────────

// Spawns REAL `npm`/git in a temp fixture and exercises the mutation kill-probe.
// Runs on Windows too: the handler routes the spawn through `runCommandSync`,
// which launches the `npm`/`npx` `.cmd` shim via `shell: true` (#1623 —
// execFile can't start a `.cmd` directly since CVE-2024-27980 / Node ≥20.12.2).
// This is the end-to-end acceptance that the cross-platform spawn actually
// works, not just the mocked handler tests.
describe('check_test_adequacy acceptance (kill probe through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort temp cleanup */
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
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-adequacy',
        taskId: 'T-01',
        branch,
        repoRoot,
      },
      ctx,
    );
    return result as { success: boolean; data: AdequacyData };
  }

  it(
    'HandleOrchestrate_CheckTestAdequacy_RealTest_PassesProbe',
    async () => {
      const repoRoot = initRepo('test-adequacy-real-');
      cleanups.push(() => rmrf(repoRoot));
      writeBaseProject(repoRoot);

      // Task diff on a feature branch: change source AND add a REAL test that
      // pins the new behavior (asserts value() === 2). Reverting calc.js back
      // to `return 1` makes this test FAIL → red observed → probe passes.
      git(repoRoot, ['checkout', '-b', 'feature/real', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export function value() {\n  return 2;\n}\n');
      writeFileSync(
        path.join(repoRoot, 'src', 'calc.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          "import { value } from './calc.js';",
          '',
          "test('value is 2', () => {",
          '  assert.strictEqual(value(), 2);',
          '});',
          '',
        ].join('\n'),
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with test', '-q']);

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

  it(
    'HandleOrchestrate_CheckTestAdequacy_AssertNothingTest_FailsProbe',
    async () => {
      const repoRoot = initRepo('test-adequacy-vacuous-');
      cleanups.push(() => rmrf(repoRoot));
      writeBaseProject(repoRoot);

      // Task diff: change source but add an ASSERT-NOTHING test. Reverting the
      // source leaves the tautology green → no red observed → probe FAILS.
      git(repoRoot, ['checkout', '-b', 'feature/vacuous', '-q']);
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
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat: bump value to 2 with vacuous test', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/vacuous');

      // The tool call still SUCCEEDS (advisory carrier); the probe FAILS.
      expect(success).toBe(true);
      expect(data.passed).toBe(false);
      expect(data.redObserved).toBe(false);
      expect(data.restoredClean).toBe(true);
    },
    120_000,
  );
});
