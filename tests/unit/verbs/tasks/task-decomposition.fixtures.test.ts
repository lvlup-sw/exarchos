// ─── check_task_decomposition: parser false-positive fixture (regression) ───
//
// This test file is the characterization regression suite for the three
// parser false-positives documented in
// `exarchos-issue-check_task_decomposition-parser-false-positives.md`. It runs
// `handleTaskDecomposition` against a real-shape plan fixture captured from the
// `agency-csl-auto-pr` dogfood and asserts the parser does NOT produce false
// positives. The fixture follows the standard `@skills/implementation-planning`
// shape (Goal / TDD steps / Acceptance criteria / Dependencies / Parallelizable)
// rather than a literal `**Description:**` field.
//
// **All three tests in this file are regression tests — these should now
// pass.** Previously failing on the v2.9.0 RED baseline, they went green
// incrementally as the downstream parser fixes landed:
//
//   - `taskDecomposition_AgencyCslAutoPr_AllTasksWellDecomposed`
//       Targets Bug 1 (Description span parsing). Current parser only counts
//       words inside a literal `**Description:**` field; the fixture uses
//       `**Goal:**` so every task reports `descriptionWordCount === 0` and
//       fails `wellDecomposed === totalTasks`. Fixed by **T-12** — replace
//       literal `**Description:**` matching with "everything between the task
//       heading and the next field-header (`**...**:`) or section header
//       (`### `)".
//
//   - `taskDecomposition_AgencyCslAutoPr_NoCycleDetected`
//       Targets Bug 2 (Greedy digit fallback in `extractDependencies`). When
//       the deps line is `**Dependencies:** T002 (\`GetCslSloRollup24h\` ...)`,
//       the `T-XX` regex misses (no hyphen), the parser falls back to a plain
//       `/[0-9]+/g` scan, and the `24` from `Rollup24h` is treated as a
//       dependency on a non-existent task. Fixed by **T-13** — match both
//       `T-XX` and `TXX` formats, anchor strictly to the deps line, and remove
//       the greedy digit fallback.
//
//   - `taskDecomposition_AgencyCslAutoPr_NoFalseFileConflicts`
//       Targets Bug 3 (Dotted-identifier file-path detection). The current
//       file-path regex `/^[a-zA-Z0-9_./-]+\.[a-zA-Z]+$/` (inside backticks)
//       matches dotted record-field tokens like
//       `\`imageProvenance.isFirstParty\``. When two parallel tasks both
//       reference the same dotted identifier in narrative prose, the parser
//       reports a false file conflict. Fixed by **T-14** — restrict file-path
//       matching to a known-extension allowlist (and optionally prefer files
//       declared under an explicit `**Files:**` section).
//
// Per the v2.9.0 dogfood-bundle plan T-11, this file does NOT modify production
// parser code. It is a regression test suite (previously the failing
// baseline) that exists to detect any future re-introduction of the three
// false positives.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock gate-utils.emitGateEvent so the handler's fire-and-forget event
// emission is observable but inert (no real EventStore needed). We do NOT
// mock `node:fs/promises` here — the test reads the real fixture file from
// disk so the integration is end-to-end.
vi.mock('../../../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn().mockResolvedValue(undefined),
  // The handler calls `requireGateEvent` directly. Without this export the
  // call site raises a TypeError instead of resolving, leaving the emission
  // unexercised — this stub always succeeds (`undefined`), since these
  // fixture cases exercise the parser, not the append failure path.
  requireGateEvent: vi.fn().mockResolvedValue(undefined),
  sameOperationGateKey: vi.fn(() => undefined),
}));
// The gate now records durable evidence through the shared phase-gate runner
// before any success carrier escapes. These cases are about the PROVIDER's
// verdict, so the runner is stubbed down to its provider call — the same seam
// every other migrated gate's unit test stubs. What the runner itself
// guarantees is proven against a real store in `gate-runner.test.ts`.
vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));


import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { EventStore } from '../../../../src/events/store.js';
import { handleTaskDecomposition } from '../../../../src/verbs/tasks/task-decomposition.js';

// Resolve the fixture path relative to this test file so the test runs from
// any cwd (vitest, scoped runs, watch mode).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, '../../../../src/verbs/fixtures/plans/agency-csl-auto-pr.md');

const STATE_DIR = '/tmp/test-state-task-decomposition-fixtures';

const mockStore = {
  append: vi.fn().mockResolvedValue(undefined),
};

interface DecompositionData {
  readonly passed: boolean;
  readonly wellDecomposed: number;
  readonly needsRework: number;
  readonly totalTasks: number;
  readonly dagValid: boolean;
  readonly parallelSafe: boolean;
  readonly report: string;
}

describe('check_task_decomposition / agency-csl-auto-pr fixture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('taskDecomposition_AgencyCslAutoPr_AllTasksWellDecomposed', async () => {
    // Bug 1 — Description span parsing. Every fixture task uses **Goal:**
    // (the standard implementation-planning shape) and has substantive prose.
    // The parser must count those words as the description; otherwise every
    // task reports descriptionWordCount === 0 and fails the structure check.
    // Fixed by T-12.
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    expect(data.totalTasks).toBeGreaterThan(0);
    // The headline assertion: every task in the fixture is well-decomposed.
    // On current code, this fails with `wellDecomposed: 0`, `needsRework: 4`
    // because the description-span parser cannot find a literal
    // `**Description:**` field in any task block.
    expect(data.wellDecomposed).toBe(data.totalTasks);
    expect(data.needsRework).toBe(0);
  });

  it('taskDecomposition_AgencyCslAutoPr_NoCycleDetected', async () => {
    // Bug 2 — Greedy digit fallback in extractDependencies. Task 033's deps
    // line is `**Dependencies:** T002 (\`GetCslSloRollup24h\` exposes ...)`.
    // The current parser falls back to scraping all digits when the T-XX
    // regex misses (no hyphen), pulling `24` out of `Rollup24h` and treating
    // it as an unknown dependency. Fixed by T-13.
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    // The headline assertion: the dependency graph is a valid DAG. On current
    // code, this fails with a CYCLE DETECTED entry of the form
    // `Unresolved dependency: 033 depends on unknown 24`.
    expect(data.dagValid).toBe(true);
    // Belt-and-suspenders: if the report drifts to a different cycle text,
    // we still want to flag the specific known false-positive.
    expect(data.report).not.toContain('unknown 24');
    expect(data.report).not.toContain('depends on unknown 24');
  });

  it('taskDecomposition_AgencyCslAutoPr_NoFalseFileConflicts', async () => {
    // Bug 3 — Dotted-identifier file-path detection. Tasks 003 and 004 both
    // reference `\`imageProvenance.isFirstParty\`` and `\`mutatingTool.detected\``
    // in narrative prose (TypeScript record field names, not file paths).
    // The current file-path regex matches anything backtick-quoted with a
    // dot and an alphabetic suffix, so the parser reports a false file
    // conflict between the two tasks. Fixed by T-14.
    const result = await handleTaskDecomposition(
      { featureId: 'fixture-agency-csl', planPath: FIXTURE_PATH },
      STATE_DIR,
      mockStore as unknown as EventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as DecompositionData;

    // The headline assertion: no parallel-safety conflicts. On current code,
    // this fails with conflicts on `imageProvenance.isFirstParty` and
    // `mutatingTool.detected`.
    expect(data.parallelSafe).toBe(true);
    // Specific dotted-identifier tokens must not appear as conflicting files.
    expect(data.report).not.toContain('imageProvenance.isFirstParty');
    expect(data.report).not.toContain('mutatingTool.detected');
  });
});
