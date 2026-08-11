// ─── prepare_synthesis: PRODUCTION-PATH proofs (DR-8 / #1756) ────────────────
//
// Why this file exists at all.
//
// `prepare-synthesis.test.ts` calls `handlePrepareSynthesis` DIRECTLY. That is
// why a fully green suite coexisted with a gate that could not receive the very
// argument it now refuses to run without: the direct-call fixtures pin the
// handler's own logic, but they never exercise the composition a real MCP/CLI
// caller travels —
//
//     exarchos_orchestrate(action:'prepare_synthesis')
//       → dispatch()                    (per-action Zod validation — STRIPS
//                                        anything the action never declared)
//       → handleOrchestrate             (adaptWithEventStoreAndConfig)
//       → handlePrepareSynthesis        (runPhaseGateWithEvidence)
//       → runTestSuite / runTypecheck / verifyStack / changedFilesAgainstBase
//
// The gap: the handler was given a REQUIRED `repoRoot`, but the registered
// action schema declared only `featureId`. `repoRoot` is declared by SIBLING
// actions (check_static_analysis, check_integration_suite, …), so dispatch's
// sibling-key stripper dropped it BEFORE validation — silently, with no
// `.strict()` complaint. Every production call arrived with
// `repoRoot === undefined` and the gate refused. Same defect class as task
// 090's `dryRun` on `transition`: a parameter accepted at the composite level
// and dropped by the action.
//
// Everything asserted here is asserted THROUGH `dispatch()`. The subprocess
// legs are stubbed so nothing spawns; what is under test is which `cwd` each
// leg is handed, not what the commands return.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The four legs shell out through these two entry points. Stub BOTH, keeping
// the rest of `node:child_process` real so unrelated modules on the dispatch
// path are unaffected.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => Buffer.from('Tests: 3 passed, 0 failed')),
    execFileSync: vi.fn(() => Buffer.from('src/touched.ts\n')),
  };
});

import { execSync, execFileSync } from 'node:child_process';

import { EventStore } from '../event-store/store.js';
import { rmrf } from '../test-helpers/temp-dir.js';
import type { DispatchContext } from '../core/dispatch.js';
import { dispatch } from '../core/dispatch.js';
import { seedActivePhaseAttempt, withTrustedCaller } from '../test-helpers/trusted-context.js';
import { TOOL_REGISTRY } from '../registry.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Every `cwd` handed to a shelled-out leg during the call under test. */
function observedLegCwds(): string[] {
  const fromExecSync = vi.mocked(execSync).mock.calls
    .map((call) => (call[1] as { cwd?: string } | undefined)?.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string');
  const fromExecFileSync = vi.mocked(execFileSync).mock.calls
    .map((call) => (call[2] as { cwd?: string } | undefined)?.cwd)
    .filter((cwd): cwd is string => typeof cwd === 'string');
  return [...fromExecSync, ...fromExecFileSync];
}

/** The shell-form commands the `execSync` legs asked for. */
function observedExecSyncCommands(): string[] {
  return vi.mocked(execSync).mock.calls.map((call) => String(call[0]));
}

describe('prepare_synthesis production path (DR-8 / #1756)', () => {
  const cleanups: Array<() => void> = [];
  let ctx: DispatchContext;
  let repoRoot: string;
  /** Held in scope so it can be closed BEFORE `stateDir` is removed. */
  let openStore: EventStore | undefined;

  const FEATURE_ID = 'feat-prepare-synthesis-prodpath';

  beforeEach(async () => {
    vi.clearAllMocks();
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-state-'));
    cleanups.push(() => rmrf(stateDir));
    // A tree that is NOT `process.cwd()` — the whole point of the fixture.
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'ps-prodpath-repo-'));
    cleanups.push(() => rmrf(repoRoot));

    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    openStore = eventStore;
    // No tasks are seeded, so task-completion is vacuously satisfied and the
    // handler proceeds to the four shelling legs — the surface under test.
    await seedActivePhaseAttempt(eventStore, FEATURE_ID, { phase: 'synthesize' });
    ctx = withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as DispatchContext);
  });

  afterEach(async () => {
    // Close the SQLite handle FIRST. `cleanups` drains in push order and
    // `rmrf(stateDir)` is registered before anything else, so a store closed
    // from inside that list would always close too late. An open handle makes
    // the directory removal fail with EBUSY on Windows (the `.db-shm` /
    // `.db-wal` class in #1623); on Linux the unlink succeeds regardless, which
    // is why this lane never surfaced the leak.
    try {
      await openStore?.close();
    } catch {
      /* best-effort */
    }
    openStore = undefined;
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  // ── THE PROOF — repoRoot survives dispatch and lands on every leg ─────────

  it('ProductionPath_DispatchWithRepoRoot_EveryLegRunsAgainstThatRoot', async () => {
    // Pre-fix this reddens at the FIRST assertion: `repoRoot` is stripped by
    // the sibling-key filter in `dispatch()` (it is declared by
    // check_static_analysis and friends, not by prepare_synthesis), the
    // handler's DR-8 guard refuses, and not one leg ever spawns.
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID, repoRoot },
      ctx,
    );

    expect(result.error?.code, JSON.stringify(result.error)).toBeUndefined();
    expect(result.success).toBe(true);

    // All four legs ran, and every one of them was told which tree to measure.
    const cwds = observedLegCwds();
    expect(cwds.length).toBeGreaterThanOrEqual(4);
    for (const cwd of cwds) {
      expect(cwd).toBe(repoRoot);
    }
    // Not one leg fell back to the directory the server happens to run in.
    expect(cwds).not.toContain(process.cwd());

    // The named legs, by the command each issues — so a future refactor that
    // drops one cannot pass on the count alone.
    const commands = observedExecSyncCommands();
    expect(commands).toContain('npm run test:run');
    expect(commands).toContain('npm run typecheck');
    expect(commands.some((c) => c.startsWith('git log '))).toBe(true);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['diff', '--name-only']),
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  // ── The refusal is at the BOUNDARY, and nothing spawns ────────────────────

  it('ProductionPath_DispatchWithoutRepoRoot_RefusedBeforeAnyLegSpawns', async () => {
    // The complement of the proof above: with `repoRoot` declared REQUIRED on
    // the action schema, an omitting caller is rejected by dispatch's own
    // validation — before the gate machinery runs and before any subprocess is
    // launched. The one outcome ruled out is a verdict measured against
    // `process.cwd()`.
    const result = await dispatch(
      'exarchos_orchestrate',
      { action: 'prepare_synthesis', featureId: FEATURE_ID },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/repoRoot/i);
    expect(observedLegCwds()).toEqual([]);

    // Rejected at the BOUNDARY, not inside the gate: with the field merely
    // `.optional()` and the handler's runtime guard doing the work, the gate
    // runner would already have minted a durable evidence row for a gate that
    // never ran. Nothing was recorded, because nothing was started.
    const evidence = await ctx.eventStore.query(FEATURE_ID, {
      type: 'admission.evidence-recorded',
    });
    expect(evidence).toEqual([]);
  });

  // ── The schema is the mechanism, so pin the schema ────────────────────────

  it('ActionSchema_DeclaresRepoRoot_AsRequiredString', () => {
    // The kill-probe target. Deleting `repoRoot` from the action schema makes
    // this fail immediately and makes the dispatch proof above fail for the
    // real reason (the value never reaches the handler) — the two together are
    // what stop the field from being quietly dropped again.
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const action = orchestrate?.actions.find((a) => a.name === 'prepare_synthesis');
    expect(action, 'prepare_synthesis must exist in the registry').toBeDefined();

    const field = (action!.schema as { shape: Record<string, { isOptional(): boolean }> })
      .shape.repoRoot;
    expect(field, 'prepare_synthesis must declare repoRoot').toBeDefined();
    expect(field.isOptional(), 'repoRoot must be REQUIRED, not optional').toBe(false);
  });
});
