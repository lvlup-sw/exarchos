// ─── mutation-adequacy action — dispatch-through integration tests ──────────
//
// Verification-ladder slice 3, R5 (#1520). These tests dispatch the
// `mutation-adequacy` action THROUGH the composite `handleOrchestrate` router
// (the DOA-action trap: a registered action with no dispatch branch returns
// UNKNOWN_ACTION — only a dispatch-through test catches that). The mutation
// runner is injected as a seam so NO real Stryker / cargo-mutants process ever
// runs in the suite (DIM-4 hermeticity).
//
// Task 003 — handler + registry + dispatch branch + Skipped/Warning degrade +
//   full-scope deferral.
// Task 004 — liveness (`mutation.executing_started`/`executed`) + foldable
//   `gate.executed { gateName, layer, mutationScore }`; idempotent re-run.
// Task 005 — survivor / NoCoverage affordances in `next_actions`.
// Task 006 — advisory verdict vs config threshold (severity reused, not
//   reinvented).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { orchestrateLogger } from '../logger.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';
import { resolveConfig } from '../config/resolve.js';
import type { ProjectConfig } from '../config/yaml-schema.js';
import type { MutationRunResult, RunDiff } from './mutation-adequacy.js';
import { composeScopedCommand } from './mutation-adequacy.js';
import { foldInFlightOperations, type OperationEventLike } from '../projections/views/lifecycle/operations-fold.js';
import { resolveMutationDiffScope } from '../config/toolchains.js';
import { rmrf } from '../test-helpers/temp-dir.js';
import { workflowStateProjection } from '../projections/views/workflow-state-projection.js';
import { guards } from '../workflow/guards.js';
import type { GuardFailure } from '../workflow/guards.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A minimal valid Stryker report with a configurable mutant mix. */
function strykerReport(mutants: ReadonlyArray<{
  status: string;
  file?: string;
  line?: number;
}>): string {
  const byFile: Record<string, { language: string; mutants: unknown[] }> = {};
  let id = 0;
  for (const m of mutants) {
    const file = m.file ?? 'src/calc.ts';
    const line = m.line ?? 1;
    byFile[file] ??= { language: 'typescript', mutants: [] };
    byFile[file].mutants.push({
      id: `m${id++}`,
      mutatorName: 'ArithmeticOperator',
      status: m.status,
      location: { start: { line, column: 1 }, end: { line, column: 9 } },
    });
  }
  return JSON.stringify({ schemaVersion: '1', files: byFile });
}

/** A resolved verification runtime whose `mutation` field is `cmd` (or null). */
function runtimeWith(cmd: string | null): ResolvedVerificationRuntime {
  return {
    test: 'npm test',
    typecheck: null,
    install: null,
    mutation: cmd,
    lint: null,
    contract: { codegen: null, diff: null },
    source: 'builtin',
    toolchainId: 'node',
    remediation: cmd ? undefined : 'install a mutation runner (e.g. stryker)',
  } as unknown as ResolvedVerificationRuntime;
}

function makeCtx(
  stateDir: string,
  eventStore: EventStore,
  projectConfig?: DispatchContext['projectConfig'],
): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false, projectConfig } as DispatchContext;
}

interface MutationData {
  passed: boolean;
  mutationScore: number;
  killed: number;
  survived: number;
  noCoverage: number;
  total: number;
  report?: unknown;
  skipped?: boolean;
  reason?: string;
  deferred?: boolean;
  warning?: string;
  next_actions?: string[];
  // DR-6 additive carrier fields.
  maxNoCoverage?: number;
  trivialPass?: boolean;
  noCoverageReason?: string;
}

// ─── harness ─────────────────────────────────────────────────────────────────

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

async function newStore(): Promise<{ stateDir: string; eventStore: EventStore }> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mutadq-state-'));
  cleanups.push(() => rmrf(stateDir));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, eventStore };
}

interface DispatchOpts {
  mutationCmd?: string | null;
  /** The injected runner's result (stdout report or a degrade). */
  runResult?: MutationRunResult;
  /** Records the commands the runner was asked to execute. */
  recordRuns?: string[];
  scope?: string;
  offline?: boolean;
  base?: string;
  threshold?: number;
  maxNoCoverage?: number;
  operationId?: string;
  projectConfig?: DispatchContext['projectConfig'];
  eventStore?: EventStore;
  stateDir?: string;
  /**
   * The diff seam. Defaults to "no files changed", which is what most cases in
   * this suite mean when they hand the runner a report directly. It matters for
   * the empty-mutant-surface cases: an empty report is a trivial pass ONLY when
   * the diff also changed nothing mutatable, so leaving this to the real git
   * would make those assertions depend on the checkout they run in.
   */
  runDiff?: (base: string, repoRoot: string) => readonly string[];
}

async function dispatchMutation(
  opts: DispatchOpts = {},
): Promise<{ success: boolean; data: MutationData; warnings?: string[] }> {
  const store = opts.eventStore
    ? { stateDir: opts.stateDir!, eventStore: opts.eventStore }
    : await newStore();
  const ctx = makeCtx(store.stateDir, store.eventStore, opts.projectConfig);
  const cmd = opts.mutationCmd === undefined ? 'npx stryker run' : opts.mutationCmd;
  const result = await handleOrchestrate(
    {
      action: 'mutation-adequacy',
      featureId: 'feat-mutadq',
      base: opts.base ?? 'main',
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.offline !== undefined ? { offline: opts.offline } : {}),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.maxNoCoverage !== undefined ? { maxNoCoverage: opts.maxNoCoverage } : {}),
      ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
      // Test seams — injected through the dispatch args.
      resolve: () => runtimeWith(cmd),
      detectToolchainId: () => 'node',
      runDiff: opts.runDiff ?? ((): readonly string[] => []),
      runMutation: (runArgs: { command: string }) => {
        opts.recordRuns?.push(runArgs.command);
        return (
          opts.runResult ?? {
            ok: true as const,
            report: strykerReport([{ status: 'Killed' }, { status: 'Survived', line: 5 }]),
          }
        );
      },
    },
    ctx,
  );
  return result as { success: boolean; data: MutationData; warnings?: string[] };
}

// ─── Task 003: handler + registry + dispatch-through ─────────────────────────

describe('mutation-adequacy action (dispatch-through handleOrchestrate)', () => {
  it('HandleOrchestrate_MutationAdequacy_ResolvesRunsParsesReturnsCarrier', async () => {
    const recordRuns: string[] = [];
    const { success, data } = await dispatchMutation({
      recordRuns,
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed' },
          { status: 'Killed' },
          { status: 'Survived', line: 5 },
          { status: 'NoCoverage', line: 9 },
        ]),
      },
    });

    expect(success).toBe(true);
    // killed / (total - noCoverage) = 2 / (4 - 1) = 0.666…
    expect(data.killed).toBe(2);
    expect(data.survived).toBe(1);
    expect(data.noCoverage).toBe(1);
    expect(data.total).toBe(4);
    expect(data.mutationScore).toBeCloseTo(2 / 3, 5);
    expect(typeof data.passed).toBe('boolean');
    expect(data.report).toBeDefined();
    // The resolved command was diff-scoped (node → --since=main) before the run.
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toContain('npx stryker run');
    expect(recordRuns[0]).toContain('--since=main');
  });

  it('HandleOrchestrate_MutationAdequacy_UnresolvedCommand_Skipped', async () => {
    const recordRuns: string[] = [];
    const { success, data } = await dispatchMutation({ mutationCmd: null, recordRuns });

    expect(success).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true); // a skip is not a failing verdict
    // The reason names a remediation path (never a silent skip).
    expect(typeof data.reason).toBe('string');
    expect(data.reason!.length).toBeGreaterThan(0);
    // No runner was invoked.
    expect(recordRuns).toHaveLength(0);
  });

  it('HandleOrchestrate_MutationAdequacy_NoToolchain_EmitsSkipPassGateExecuted', async () => {
    // DR-2a: no toolchain still emits a skip-passing gate.executed so the
    // projection records reviews['mutation-adequacy'] as skip-pass — otherwise
    // review→synthesize dead-locks at HIGH tier on a repo with no mutation runner.
    const { stateDir, eventStore } = await newStore();
    const { success, data } = await dispatchMutation({ mutationCmd: null, eventStore, stateDir });
    expect(success).toBe(true);
    expect(data.skipped).toBe(true);

    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const gate = events.find(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(gate).toBeDefined();
    const gd = gate!.data as {
      layer?: string;
      passed?: boolean;
      details?: { skipped?: boolean; degraded?: boolean };
    };
    expect(gd.layer).toBe('review');
    expect(gd.passed).toBe(true);
    expect(gd.details?.skipped).toBe(true);
    // RVC-R1: the no-toolchain skip-pass is NOT marked degraded — that marker is
    // reserved for a present-but-broken runner, so block enforcement can tell the
    // two apart (a backstop the repo cannot run stays advisory even under block).
    expect(gd.details?.degraded).toBeUndefined();
  });

  it('HandleOrchestrate_MutationAdequacy_MalformedReport_Warning', async () => {
    const { success, data } = await dispatchMutation({
      runResult: { ok: true, report: 'not-json-at-all{' },
    });

    // Degrade to a Warning carrier — success:true, NEVER a throw / error envelope.
    expect(success).toBe(true);
    expect(typeof data.warning).toBe('string');
    expect(data.warning!.length).toBeGreaterThan(0);
    // A degraded report has no usable score; passed is not a hard failure.
    expect(data.passed).toBe(true);
  });

  it('HandleOrchestrate_MutationAdequacy_MalformedReport_EmitsDegradedSkipPass_RVC_R1', async () => {
    // RVC-R1: a degrade (toolchain PRESENT, unparseable report) records a skip-pass
    // marked degraded:true — DISTINCT from the no-toolchain skip-pass — so the
    // block-enforcement score gate can fail closed while advisory stays live.
    const { stateDir, eventStore } = await newStore();
    const { success } = await dispatchMutation({
      runResult: { ok: true, report: 'not-json-at-all{' },
      eventStore,
      stateDir,
    });
    expect(success).toBe(true);

    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const gate = events.find(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(gate).toBeDefined();
    const gd = gate!.data as { passed?: boolean; details?: { skipped?: boolean; degraded?: boolean } };
    expect(gd.passed).toBe(true);
    expect(gd.details?.skipped).toBe(true);
    expect(gd.details?.degraded).toBe(true);
  });

  it('HandleOrchestrate_MutationAdequacy_RunnerFailure_EmitsDegradedSkipPass_RVC_R1', async () => {
    // The runner-crash degrade (ok:false) is the other degrade path — also marked
    // degraded:true so block enforcement fails closed on a broken runner rather
    // than silently passing review→synthesize.
    const { stateDir, eventStore } = await newStore();
    const { success } = await dispatchMutation({
      runResult: { ok: false, reason: 'stryker exited 1' },
      eventStore,
      stateDir,
    });
    expect(success).toBe(true);

    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const gate = events.find(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(gate).toBeDefined();
    const gd = gate!.data as { passed?: boolean; details?: { skipped?: boolean; degraded?: boolean } };
    expect(gd.passed).toBe(true);
    expect(gd.details?.skipped).toBe(true);
    expect(gd.details?.degraded).toBe(true);
  });

  it('HandleOrchestrate_MutationAdequacy_SameOperationId_DegradeThenScore_BothRowsPersist_RVC_R7', async () => {
    // RVC-R7 (CodeRabbit): gate.executed emissions are keyed by operationId
    // SUFFIXED with outcome, so a degraded row does NOT suppress a later scored
    // row for the same operationId (the bare-operationId key deduped the second
    // emission, stranding the skip-pass and losing the real score).
    const { stateDir, eventStore } = await newStore();
    const op = 'op-shared-123';

    // First run degrades (unparseable report) → degraded skip-pass row.
    await dispatchMutation({
      runResult: { ok: true, report: 'not-json{' },
      operationId: op,
      eventStore,
      stateDir,
    });
    // Retry under the SAME operationId scores a real result → scored row.
    await dispatchMutation({
      runResult: { ok: true, report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }]) },
      operationId: op,
      eventStore,
      stateDir,
    });

    const mut = (await eventStore.query('feat-mutadq', { type: 'gate.executed' })).filter(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    // Both rows persist — a shared bare-operationId key would have collapsed to 1.
    expect(mut.length).toBe(2);
    // The scored row (not degraded, real score) survives for the projection to fold.
    const scored = mut.find((e) => {
      const d = (e.data as { details?: { degraded?: boolean; mutationScore?: number } }).details;
      return d?.degraded !== true && typeof d?.mutationScore === 'number' && d.mutationScore > 0;
    });
    expect(scored).toBeDefined();
  });

  it('HandleOrchestrate_MutationAdequacy_FullScope_DeferredAdvisory', async () => {
    const recordRuns: string[] = [];
    const { success, data } = await dispatchMutation({ scope: 'full', recordRuns });

    expect(success).toBe(true);
    expect(data.deferred).toBe(true);
    expect(typeof data.reason).toBe('string');
    expect(data.reason).toMatch(/R10|v2\.12|deferred/i);
    // No inline full-tree run — the runner was never invoked.
    expect(recordRuns).toHaveLength(0);
  });

  it('HandleOrchestrate_MutationAdequacy_FullScopeOffline_RunsFullTreeScored', async () => {
    // DR-6: the explicit offline opt-in runs the WHOLE tree and produces a scored
    // result — not the deferred advisory — with an unscoped command (no diff --since).
    const recordRuns: string[] = [];
    const { stateDir, eventStore } = await newStore();
    const { success, data } = await dispatchMutation({
      scope: 'full',
      offline: true,
      eventStore,
      stateDir,
      recordRuns,
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }, { status: 'Survived' }]),
      },
    });

    expect(success).toBe(true);
    expect(data.deferred).toBeUndefined(); // actually ran — not deferred
    expect(data.mutationScore).toBeCloseTo(2 / 3, 5);
    // Ran once, full-tree: the command is the resolved runner verbatim, unscoped.
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toContain('npx stryker run');
    expect(recordRuns[0]).not.toContain('--since');
    // Foldable gate.executed emitted (INV-1) so the offline run records the dimension.
    const gates = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    expect(
      gates.some((e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy'),
    ).toBe(true);
  });

  it('HandleOrchestrate_MutationAdequacy_FullScopeWithoutOffline_StaysDeferred', async () => {
    // Inline /review never sets `offline` → full-tree is never run inline.
    const recordRuns: string[] = [];
    const { data } = await dispatchMutation({ scope: 'full', offline: false, recordRuns });
    expect(data.deferred).toBe(true);
    expect(recordRuns).toHaveLength(0);
  });

  it('Registry_MutationAdequacyAction_HasHandlerBranch', async () => {
    // A registered action with no handleOrchestrate branch returns UNKNOWN_ACTION.
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    const result = await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        resolve: () => runtimeWith('npx stryker run'),
        runMutation: () => ({
          ok: true as const,
          report: strykerReport([{ status: 'Killed' }]),
        }),
      },
      ctx,
    );
    // NOT an UNKNOWN_ACTION error — the dispatch branch exists.
    if (result.success === false) {
      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    }
    expect(result.success).toBe(true);
  });
});

// ─── DR-10: real-runner degrade attributes the runner's stderr (#1719) ─────
//
// Every test above injects `runMutation`, so none of them ever exercise the
// PRODUCTION default (`defaultRunMutation`) — the one that actually shells
// out and catches `execFileSync`'s thrown error. On PR #1719,
// `check-mutation-gate.mjs --observe` surfaced `mutation run produced no
// report (exit 1)` with no underlying reason because that catch read
// `e.stdout` but never `e.stderr`, silently dropping the runner's actual
// diagnostic. This test drives the UNMOCKED default runner (no `runMutation`
// seam) against a real child process that fails with a KNOWN stderr marker
// and nothing parseable on stdout, then asserts the degrade `reason` the
// handler surfaces CONTAINS that marker — proving the underlying failure is
// now attributable (DR-10), not silently dropped.

describe('mutation-adequacy real runner — DR-10 stderr attribution (#1719)', () => {
  it('HandleOrchestrate_MutationAdequacy_RealRunnerFailure_DegradeReasonContainsStderrTail', async () => {
    const marker = 'MUTATION_DR10_STDERR_MARKER_9f3c1a';
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'mutadq-fixture-'));
    cleanups.push(() => rmrf(fixtureDir));
    const script = path.join(fixtureDir, 'fail-runner.mjs');
    writeFileSync(
      script,
      `process.stderr.write(${JSON.stringify(marker)});\nprocess.exit(3);\n`,
    );

    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    const result = (await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        // No `runMutation` injected — exercises the real, unmocked
        // `defaultRunMutation` shell-out + catch path.
        resolve: () => runtimeWith(`${process.execPath} ${script}`),
        // An unrecognised toolchain has no diff-scope augmentation
        // (`resolveMutationDiffScope` → 'unscoped-warning'), so the command
        // runs EXACTLY as resolved — no `--since` flag appended.
        detectToolchainId: () => 'no-such-toolchain-xyz',
      },
      ctx,
    )) as { success: boolean; data: MutationData; warnings?: string[] };

    expect(result.success).toBe(true);
    // A run-level degrade (no parseable report) surfaces as a Warning carrier
    // — never a throw / error envelope.
    expect(typeof result.data.warning).toBe('string');
    // DR-10: the reason names WHY the run produced no report, not just THAT
    // it did — the runner's captured stderr must be attributable in it.
    expect(result.data.warning).toContain(marker);
    expect(result.data.warning).toContain('mutation run produced no report');
  });
});

// ─── Diff-scope applier resolution (DR-5 / Gap C) ────────────────────────────
//
// The diff-scope DESCRIPTOR encodes intent (toolchains SoT); the applier
// (composeScopedCommand) materializes it against the injected `runDiff` seam.
// PIT's `-DtargetClasses=<changed>` resolves to the changed Java classes; mutmut
// path-restricts to the changed `.py` paths. A normal diff-scoped run substitutes
// the placeholder and does NOT degrade to the unscoped-warning. Only when the
// diff touches no scopable file does the applier fall back to the warning
// contract (never a literal `<changed>`, never silent full-tree). These dispatch
// through handleOrchestrate with injected `detectToolchainId` + `runDiff` seams.

/** Dispatch the action for a specific detected toolchain, capturing runs. */
async function dispatchForToolchain(
  toolchainId: string,
  opts: { scope?: string; recordRuns?: string[]; runDiff?: RunDiff } = {},
): Promise<{ success: boolean; data: MutationData; warnings?: string[]; error?: { code?: string } }> {
  const { stateDir, eventStore } = await newStore();
  const ctx = makeCtx(stateDir, eventStore);
  const result = await handleOrchestrate(
    {
      action: 'mutation-adequacy',
      featureId: 'feat-mutadq',
      base: 'main',
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      resolve: () => runtimeWith('mutate run'),
      detectToolchainId: () => toolchainId,
      // Injected diff seam — keeps the suite hermetic (no real git/diff).
      ...(opts.runDiff ? { runDiff: opts.runDiff } : {}),
      runMutation: (runArgs: { command: string }) => {
        opts.recordRuns?.push(runArgs.command);
        return { ok: true as const, report: strykerReport([{ status: 'Killed' }]) };
      },
    },
    ctx,
  );
  return result as { success: boolean; data: MutationData; warnings?: string[]; error?: { code?: string } };
}

describe('mutation-adequacy diff-scope applier resolution', () => {
  it('MutationAdequacy_JavaScope_ResolvesChangedClasses_NoDegradeWarning', async () => {
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('java-maven', {
      recordRuns,
      runDiff: () => ['src/main/java/com/example/Calc.java'],
    });

    expect(success).toBe(true);
    expect(recordRuns).toHaveLength(1);
    // `<changed>` resolved to the FQCN — the literal placeholder never ships.
    expect(recordRuns[0]).not.toContain('<changed>');
    expect(recordRuns[0]).toContain('-DtargetClasses=com.example.Calc');
    // A normal diff-scoped run does NOT degrade to the unscoped warning.
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).not.toMatch(/unscoped|full-tree/i);
  });

  it('MutationAdequacy_PythonPathRestricted_RestrictsToChangedPaths_NoDegradeWarning', async () => {
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('python', {
      recordRuns,
      runDiff: () => ['app/calc.py', 'app/util.py'],
    });

    expect(success).toBe(true);
    expect(recordRuns).toHaveLength(1);
    // mutmut path-restricts to the changed `.py` paths (--paths-to-mutate).
    expect(recordRuns[0]).toContain('--paths-to-mutate=');
    expect(recordRuns[0]).toContain('app/calc.py');
    expect(recordRuns[0]).toContain('app/util.py');
    expect(recordRuns[0]).not.toContain('<changed>');
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).not.toMatch(/unscoped|full-tree/i);
  });

  it('MutationAdequacy_JavaScope_EmptyRelevantDiff_DegradesToWarning_NeverSilentFullTree', async () => {
    // Boundary: a diff with no Java sources cannot be scoped — degrade to the
    // unscoped warning (never an empty `-DtargetClasses=`, never silent full-tree).
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('java-maven', {
      recordRuns,
      runDiff: () => ['docs/readme.md'],
    });

    expect(success).toBe(true);
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toBe('mutate run');
    expect(recordRuns[0]).not.toContain('<changed>');
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).toMatch(/unscoped|full-tree/i);
  });

  it('MutationAdequacy_RustNativeScope_AppendsNothing_NoWarning', async () => {
    // Control: cargo-mutants is already --in-diff; the applier appends nothing
    // and surfaces no scope-downgrade warning (and never consults the diff seam).
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('rust', { recordRuns });

    expect(success).toBe(true);
    expect(recordRuns).toEqual(['mutate run']);
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).not.toMatch(/unscoped|full-tree|path-restricted/i);
  });
});

// ─── composeScopedCommand — shape-based unit tests (mocked diff seam) ────────
//
// Acceptance criterion #3 (DR-5 / Gap C): call the applier directly with a
// MOCKED `runDiff` — no live mutation run, no real git. PIT resolves `<changed>`
// to the changed classes; mutmut path-restricts to the changed `.py` paths;
// neither degrades to the unscoped-warning on a normal diff. The descriptor is
// pulled from the toolchains SoT (resolveMutationDiffScope), not hand-built.

describe('composeScopedCommand diff-seam resolution (DR-5 / Gap C)', () => {
  /** A ScopeContext whose mocked diff returns a fixed changed-file set. */
  const ctxWithDiff = (changed: readonly string[]) => ({
    base: 'main',
    repoRoot: '/repo',
    runDiff: (() => changed) as RunDiff,
  });

  it('Pit_ResolvesChangedPlaceholderToChangedClasses_NoDegradeWarning', () => {
    const scope = resolveMutationDiffScope('java-maven', 'main'); // -DtargetClasses=<changed>
    const out = composeScopedCommand(
      'mvn org.pitest:pitest-maven:mutationCoverage',
      scope,
      ctxWithDiff([
        'src/main/java/com/example/Calc.java',
        'src/test/java/com/example/CalcTest.java',
      ]),
    );

    expect(out.warning).toBeUndefined();
    expect(out.command).toContain('-DtargetClasses=');
    expect(out.command).toContain('com.example.Calc');
    expect(out.command).toContain('com.example.CalcTest');
    // The literal `<changed>` placeholder is fully substituted — never shipped.
    expect(out.command).not.toContain('<changed>');
  });

  it('Mutmut_PathRestrictsToChangedPaths_NoDegradeWarning', () => {
    const scope = resolveMutationDiffScope('python', 'main'); // --paths-to-mutate=<changed>
    const out = composeScopedCommand(
      'mutmut run',
      scope,
      ctxWithDiff(['app/calc.py', 'app/util.py', 'README.md']),
    );

    expect(out.warning).toBeUndefined();
    expect(out.command).toContain('--paths-to-mutate=');
    expect(out.command).toContain('app/calc.py');
    expect(out.command).toContain('app/util.py');
    // Non-`.py` files are not path-restriction targets.
    expect(out.command).not.toContain('README.md');
    expect(out.command).not.toContain('<changed>');
  });

  it('Stryker_AppendFlagWithoutPlaceholder_AppendsVerbatim_NeverCallsDiff', () => {
    // Control: Stryker's `--since=<base>` carries no `<changed>`; the seam is
    // never consulted and nothing degrades.
    let called = false;
    const scope = resolveMutationDiffScope('node', 'origin/main');
    const out = composeScopedCommand('npx stryker run', scope, {
      base: 'origin/main',
      repoRoot: '/repo',
      runDiff: () => {
        called = true;
        return [];
      },
    });

    expect(out.warning).toBeUndefined();
    expect(out.command).toBe('npx stryker run --since=origin/main');
    expect(called).toBe(false);
  });

  it('Rust_AlreadyNative_AppendsNothing_NeverCallsDiff', () => {
    let called = false;
    const scope = resolveMutationDiffScope('rust', 'main');
    const out = composeScopedCommand('cargo mutants --in-diff', scope, {
      base: 'main',
      repoRoot: '/repo',
      runDiff: () => {
        called = true;
        return [];
      },
    });

    expect(out).toEqual({ command: 'cargo mutants --in-diff' });
    expect(called).toBe(false);
  });

  it('Pit_EmptyRelevantDiff_DegradesToUnscopedWarning_NeverSilentFullTree', () => {
    const scope = resolveMutationDiffScope('java-maven', 'main');
    const out = composeScopedCommand(
      'mvn org.pitest:pitest-maven:mutationCoverage',
      scope,
      ctxWithDiff(['docs/readme.md']), // no `.java` files changed
    );

    // Never ship an empty `-DtargetClasses=`; degrade to a visible warning.
    expect(out.command).toBe('mvn org.pitest:pitest-maven:mutationCoverage');
    expect(out.warning).toMatch(/unscoped|full-tree/i);
  });

  it('Mutmut_EmptyRelevantDiff_DegradesToUnscopedWarning', () => {
    const scope = resolveMutationDiffScope('python', 'main');
    const out = composeScopedCommand('mutmut run', scope, ctxWithDiff(['docs/readme.md']));

    expect(out.command).toBe('mutmut run');
    expect(out.warning).toMatch(/unscoped|full-tree/i);
  });
});

describe('mutation-adequacy scope validation (INV-5a/5b)', () => {
  it('MutationAdequacy_InvalidScope_ReturnsInvalidInput_NeverRuns', async () => {
    const recordRuns: string[] = [];
    const { success, error } = await dispatchForToolchain('node', {
      scope: 'dif', // a typo — must NOT be coerced to 'diff'
      recordRuns,
    });

    expect(success).toBe(false);
    expect(error?.code).toBe('INVALID_INPUT');
    // Rejected before any runner work.
    expect(recordRuns).toHaveLength(0);
  });

  it('MutationAdequacy_ExplicitDiffScope_RunsScoped', async () => {
    const recordRuns: string[] = [];
    const { success } = await dispatchForToolchain('node', { scope: 'diff', recordRuns });
    expect(success).toBe(true);
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toContain('--since=main');
  });
});

describe("mutation-adequacy repoRoot:'auto' resolution (PR #1541 Seer)", () => {
  it('MutationAdequacy_AutoRepoRoot_ResolvesFromWorktreeCreatedEvent', async () => {
    const { stateDir, eventStore } = await newStore();
    // Seed the task's worktree.created event that `repoRoot:'auto'` resolves
    // against — the handler must thread `taskId` to resolveRepoRoot for this.
    await eventStore.append('feat-mutadq', {
      type: 'worktree.created',
      data: { taskId: 'task-007', path: '/tmp/wt/task-007' },
    });
    const ctx = makeCtx(stateDir, eventStore);

    let seenRepoRoot: string | undefined;
    const result = await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        repoRoot: 'auto',
        taskId: 'task-007',
        resolve: () => runtimeWith('npx stryker run'),
        detectToolchainId: () => 'node',
        runMutation: (runArgs: { command: string; repoRoot: string }) => {
          seenRepoRoot = runArgs.repoRoot;
          return { ok: true as const, report: strykerReport([{ status: 'Killed' }]) };
        },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // 'auto' resolved to the task's worktree via the event lookup (taskId threaded).
    expect(seenRepoRoot).toBe('/tmp/wt/task-007');
  });

  it('MutationAdequacy_AutoRepoRoot_NoTaskIdNoWorktree_InvalidInput', async () => {
    // Boundary: 'auto' with neither taskId nor worktreePath is unresolvable —
    // surface INVALID_INPUT and never invoke the runner.
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);

    let ran = false;
    const result = await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        repoRoot: 'auto',
        resolve: () => runtimeWith('npx stryker run'),
        detectToolchainId: () => 'node',
        runMutation: () => {
          ran = true;
          return { ok: true as const, report: strykerReport([{ status: 'Killed' }]) };
        },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error?.code).toBe('INVALID_INPUT');
    }
    expect(ran).toBe(false);
  });
});


// ─── Task 004: liveness + gate.executed ──────────────────────────────────────

describe('mutation-adequacy liveness + gate emission', () => {
  it('MutationAdequacy_TerminalLivenessEmitFails_DegradesWithoutThrowingButLogsTrail', async () => {
    // The no-throw degrade is deliberate (INV-4): a liveness-emission failure
    // must not fail a mutation run that actually succeeded. But an empty
    // `catch {}` also discarded the only breadcrumb — and a lost TERMINAL event
    // is the consequential case: `computeInFlightInstances` has no TTL, so the
    // unpaired start reports in-flight to `ps` until an S-6 registry terminal
    // lands. Degrade, but leave a diagnostic trail (RVC-R4).
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    const warn = vi.spyOn(orchestrateLogger, 'warn').mockImplementation(() => undefined);

    // Fail ONLY the terminal append; the opening one must still land.
    const realAppend = eventStore.append.bind(eventStore);
    vi.spyOn(eventStore, 'append').mockImplementation(
      async (stream: string, event: { type: string }) => {
        if (event.type === 'mutation.executed') throw new Error('append boom');
        return realAppend(stream, event);
      },
    );

    // The run still completes — the emission failure does not surface as a throw.
    await expect(dispatchMutation({ eventStore, stateDir })).resolves.toBeDefined();

    // …and the failure is no longer silent: the trail names the terminal type
    // and the instance an operator would otherwise reverse-engineer from `ps`.
    const terminalWarn = warn.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'mutation.executed',
    );
    expect(terminalWarn).toBeDefined();
    expect((terminalWarn![0] as { instanceId?: string }).instanceId).toBeDefined();
    expect((terminalWarn![0] as { consequence?: string }).consequence).toBe(
      'unpaired-start-reports-in-flight',
    );

    vi.restoreAllMocks();
  });

  it('MutationAdequacy_RunMutationRejects_StillEmitsPairedTerminalExecuted', async () => {
    // `defaultRunMutation` handles its own sync failures, but the INJECTED
    // seam can reject. The terminal event must still land: an unpaired
    // `mutation.executing_started` pins the run in-flight forever — `ps`
    // reports a phantom executing mutation and `wait --operation mutation`
    // blocks to timeout, because DR-2 pairing resolves an instance only when
    // its terminal event arrives.
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);

    const result = (await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        resolve: () => runtimeWith('npx stryker run'),
        detectToolchainId: () => 'node',
        runMutation: () => Promise.reject(new Error('runner exploded')),
      },
      ctx,
    )) as { success: boolean; error?: { code?: string; message?: string } };

    // #1706 DR-1: a rejecting injected seam must return a coded
    // ToolResult.error, not let the throw abnormally complete the handler
    // (which dispatch.ts's safety net would otherwise flatten to a generic
    // INTERNAL_ERROR, discarding this classification).
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_ERROR');
    expect(result.error?.message).toContain('runner exploded');

    const events = await eventStore.query('feat-mutadq');
    const started = events.find((e) => e.type === 'mutation.executing_started');
    const executed = events.find((e) => e.type === 'mutation.executed');
    expect(started).toBeDefined();
    // The pair is CLOSED despite the rejection — no phantom in-flight instance.
    expect(executed).toBeDefined();
    // …and it closes THIS instance (same instanceId) as a failure.
    const startedData = started!.data as { instanceId?: string };
    const executedData = executed!.data as { instanceId?: string; passed?: boolean };
    expect(executedData.instanceId).toBe(startedData.instanceId);
    expect(executedData.passed).toBe(false);
  });

  it('MutationAdequacy_Run_EmitsExecutingStartedThenExecuted', async () => {
    const { stateDir, eventStore } = await newStore();
    await dispatchMutation({ eventStore, stateDir });

    const events = await eventStore.query('feat-mutadq');
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf('mutation.executing_started');
    const endIdx = types.indexOf('mutation.executed');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it('MutationAdequacy_LivenessPair_CarriesCanonicalInstanceId_AndFoldsToPaired', async () => {
    // Finding 3: the LIVE emitter (mutation-adequacy) must stamp a canonical
    // `instanceId` on BOTH liveness emissions so a stuck mutation run is visible
    // to `ps` and waitable — not an anonymous keyless row collapsed to the DR-2
    // singleton. Passing an operationId correlates the instanceId with the gate.
    const { stateDir, eventStore } = await newStore();
    await dispatchMutation({ eventStore, stateDir, operationId: 'op-mut-42' });

    const events = await eventStore.query('feat-mutadq');
    const start = events.find((e) => e.type === 'mutation.executing_started');
    const end = events.find((e) => e.type === 'mutation.executed');
    const startId = (start?.data as { instanceId?: unknown } | undefined)?.instanceId;
    const endId = (end?.data as { instanceId?: unknown } | undefined)?.instanceId;

    // Both emissions carry a non-empty instanceId, equal to each other and to
    // the supplied operationId (the correlation contract, mirroring run-mutation).
    expect(typeof startId).toBe('string');
    expect((startId as string).length).toBeGreaterThan(0);
    expect(endId).toBe(startId);
    expect(startId).toBe('op-mut-42');

    // And the pair folds cleanly: the terminal clears the start → nothing stuck.
    const rows = foldInFlightOperations(events as unknown as OperationEventLike[]);
    expect(rows.some((r) => r.surface === 'mutation')).toBe(false);
  });

  it('MutationAdequacy_StuckRun_VisibleToOperationsFold_WithFeatureAttribution', async () => {
    // The S-6 case at the LIVE-emitter level: if the terminal never lands (a
    // crashed run — simulated by dropping the `mutation.executed` event), the
    // unpaired start is surfaced by the fold, keyed by the canonical instanceId
    // and attributed to the feature stream — exactly what `ps operations` /
    // `wait --operation mutation` consume.
    const { stateDir, eventStore } = await newStore();
    await dispatchMutation({ eventStore, stateDir, operationId: 'op-stuck' });

    const events = (await eventStore.query('feat-mutadq')).filter(
      (e) => e.type !== 'mutation.executed',
    );
    const rows = foldInFlightOperations(events as unknown as OperationEventLike[]);
    const stuck = rows.find((r) => r.surface === 'mutation');
    expect(stuck).toBeDefined();
    expect(stuck?.instanceKey).toBe('op-stuck');
    expect(stuck?.streamId).toBe('feat-mutadq');
    expect(stuck?.featureId).toBe('feat-mutadq');
  });

  it('MutationAdequacy_Result_EmitsGateExecutedWithScore', async () => {
    const { stateDir, eventStore } = await newStore();
    await dispatchMutation({
      eventStore,
      stateDir,
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }, { status: 'Survived' }]),
      },
    });

    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const gate = events.find(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(gate).toBeDefined();
    const data = gate!.data as { layer?: string; details?: { mutationScore?: number } };
    expect(data.layer).toBe('review');
    expect(data.details?.mutationScore).toBeCloseTo(2 / 3, 5);
  });

  it('MutationAdequacy_GateExecuted_FoldsIntoScoreTrend', async () => {
    // R10-ready: a sequence of gate.executed left-folds into a score trend.
    const { stateDir, eventStore } = await newStore();
    const scores = [0.4, 0.6, 0.8];
    for (const [i, killedCount] of [2, 3, 4].entries()) {
      const mutants = [
        ...Array.from({ length: killedCount }, () => ({ status: 'Killed' })),
        { status: 'Survived' },
      ];
      // tune denominators so scores roughly ascend; exact value asserted via fold
      void i;
      await dispatchMutation({
        eventStore,
        stateDir,
        operationId: `op-${killedCount}`,
        runResult: { ok: true, report: strykerReport(mutants) },
      });
      void scores;
    }
    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const trend = events
      .map((e) => (e.data as { details?: { mutationScore?: number } }).details?.mutationScore)
      .filter((s): s is number => typeof s === 'number');
    expect(trend.length).toBe(3);
    // Monotonic non-decreasing fold (the trend R10 reads).
    for (let i = 1; i < trend.length; i++) {
      expect(trend[i]).toBeGreaterThanOrEqual(trend[i - 1]);
    }
  });

  it('MutationAdequacy_Retry_IdempotentNoCasPin', async () => {
    const { stateDir, eventStore } = await newStore();
    const opts = {
      eventStore,
      stateDir,
      operationId: 'op-retry',
      runResult: {
        ok: true as const,
        report: strykerReport([{ status: 'Killed' }, { status: 'Survived' }]),
      },
    };
    await dispatchMutation(opts);
    // A retry under the SAME operationId must collapse, not throw a CAS conflict.
    await expect(dispatchMutation(opts)).resolves.toBeDefined();

    const gates = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const mutationGates = gates.filter(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    // Idempotency-collapse → exactly one gate.executed for the operationId.
    expect(mutationGates).toHaveLength(1);
  });
});


// ─── Task 005: survivor affordances ──────────────────────────────────────────

describe('mutation-adequacy survivor affordances (next_actions)', () => {
  it('MutationAdequacy_SurvivingMutants_EmitKillTestNextActions', async () => {
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed' },
          { status: 'Survived', file: 'src/calc.ts', line: 12 },
        ]),
      },
    });
    const actions = data.next_actions ?? [];
    expect(actions.some((a) => /write a test that kills src\/calc\.ts:12/.test(a))).toBe(true);
  });

  it('MutationAdequacy_NoCoverageMutants_EmitKillTestNextActions', async () => {
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed' },
          { status: 'NoCoverage', file: 'src/util.ts', line: 7 },
        ]),
      },
    });
    const actions = data.next_actions ?? [];
    expect(actions.some((a) => /write a test that kills src\/util\.ts:7/.test(a))).toBe(true);
  });

  it('MutationAdequacy_AllKilled_NoSurvivorAffordances', async () => {
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }]),
      },
    });
    const actions = data.next_actions ?? [];
    expect(actions.some((a) => /write a test that kills/.test(a))).toBe(false);
  });
});

// ─── Task 006: advisory verdict + threshold ──────────────────────────────────

function configWith(overrides: Partial<ProjectConfig>): DispatchContext['projectConfig'] {
  return resolveConfig(overrides as ProjectConfig);
}

describe('mutation-adequacy advisory verdict + threshold', () => {
  it('MutationAdequacy_ScoreBelowThreshold_PassedFalseButAdvisory', async () => {
    // 1 killed / 3 detectable = 0.33 < 0.40 default → passed:false but ADVISORY.
    const result = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed' },
          { status: 'Survived', line: 4 },
          { status: 'Survived', line: 5 },
        ]),
      },
    });
    expect(result.success).toBe(true);
    expect(result.data.passed).toBe(false);
    // Advisory: never an error envelope; the failing verdict does not block.
    expect(result.data.mutationScore).toBeLessThan(0.4);
  });

  it('MutationAdequacy_ExplicitOverride_Blocking', async () => {
    // An explicit review.gates override raises severity to blocking.
    const blockingConfig = configWith({
      review: { gates: { 'mutation-adequacy': { enabled: true, blocking: true } } },
    } as Partial<ProjectConfig>);
    const result = (await dispatchMutation({
      projectConfig: blockingConfig,
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Survived' }, { status: 'Survived' }]),
      },
    })) as { success: boolean; data: MutationData; warnings?: string[] };
    expect(result.data.passed).toBe(false);
    // Blocking severity does NOT annotate a warning-only downgrade.
    const warnings = (result as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => /warning-only/.test(w))).toBe(false);
  });

  it('MutationAdequacy_NoThresholdConfig_DefaultsToSoftAdvisory', async () => {
    // No threshold config → soft default (~0.40); a sub-default score warns,
    // never blocks (advisory severity from the resolved default). The warning-only
    // downgrade CLEARS the blocking signal (data.passed → true) and carries the
    // finding as a warning — leaving data.passed:false would still block the
    // dispatch (the contract the orchestrator reads). See the DR-6 review fix.
    const advisoryConfig = configWith({} as Partial<ProjectConfig>);
    const result = (await dispatchMutation({
      projectConfig: advisoryConfig,
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Survived' }, { status: 'Survived' }]),
      },
    })) as { success: boolean; data: MutationData; warnings?: string[] };
    expect(result.success).toBe(true);
    expect(result.data.passed).toBe(true);
    const warnings = (result as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => /warning-only/.test(w))).toBe(true);
  });
});

// ─── DR-6: NoCoverage as a SECOND, orthogonal blocking axis (handler) ─────────
//
// `mutationScore = killed / (total − noCoverage)` is UNCHANGED (INV-5b). For a
// diff-scoped run the handler additionally requires `noCoverage <= maxNoCoverage`
// (default 0). An empty mutatable surface (`total === 0`) is a trivial pass.

describe('mutation-adequacy NoCoverage axis (DR-6)', () => {
  it('Passed_DiffScopeKilledPlusNoCoverageMix_Fails', async () => {
    // 5 killed + 5 NoCoverage → mutationScore = 5 / (10 − 5) = 1.0 (>= threshold),
    // yet the diff has 5 uncovered changed mutants: TODAY this passed at score 1.0.
    // DR-6: the NoCoverage axis (budget 0) now FAILS it while the score is
    // untouched.
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'Killed', line: 2 },
          { status: 'Killed', line: 3 },
          { status: 'Killed', line: 4 },
          { status: 'Killed', line: 5 },
          { status: 'NoCoverage', line: 11 },
          { status: 'NoCoverage', line: 12 },
          { status: 'NoCoverage', line: 13 },
          { status: 'NoCoverage', line: 14 },
          { status: 'NoCoverage', line: 15 },
        ]),
      },
    });
    // mutationScore definition UNCHANGED — still 1.0 (INV-5b).
    expect(data.mutationScore).toBeCloseTo(1.0, 5);
    expect(data.noCoverage).toBe(5);
    // The orthogonal axis blocks despite the perfect score.
    expect(data.passed).toBe(false);
    expect(data.maxNoCoverage).toBe(0);
  });

  it('Passed_AllCoveredAtThreshold_PassesUnchanged', async () => {
    // An all-covered diff at the same 1.0 score (0 NoCoverage) still PASSES on the
    // handler path — the score axis is byte-identical to before (INV-5b guardrail).
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'Killed', line: 2 },
          { status: 'Killed', line: 3 },
        ]),
      },
    });
    expect(data.mutationScore).toBeCloseTo(1.0, 5);
    expect(data.noCoverage).toBe(0);
    expect(data.passed).toBe(true);
  });

  it('Passed_NoCoverageWithinExplicitBudget_Passes', async () => {
    // With an explicit budget of 2, a diff with 2 NoCoverage mutants (and a
    // passing score) is within budget → PASSES. The budget is honoured.
    const { data } = await dispatchMutation({
      maxNoCoverage: 2,
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'Killed', line: 2 },
          { status: 'NoCoverage', line: 11 },
          { status: 'NoCoverage', line: 12 },
        ]),
      },
    });
    expect(data.noCoverage).toBe(2);
    expect(data.maxNoCoverage).toBe(2);
    expect(data.passed).toBe(true);
    // One more uncovered mutant beyond the same budget flips it closed.
    const over = await dispatchMutation({
      maxNoCoverage: 2,
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'Killed', line: 2 },
          { status: 'NoCoverage', line: 11 },
          { status: 'NoCoverage', line: 12 },
          { status: 'NoCoverage', line: 13 },
        ]),
      },
    });
    expect(over.data.noCoverage).toBe(3);
    expect(over.data.passed).toBe(false);
  });

  it('Passed_EmptyMutatableSurface_TrivialPassWithMarker', async () => {
    // total === 0 with a diff that changed NOTHING mutatable is a TRIVIAL PASS
    // with an explicit marker: not a score-0 failure, not a degrade. The empty
    // `runDiff` is what makes it a server-untouching diff rather than an
    // assumption about the checkout.
    const { success, data } = await dispatchMutation({
      runDiff: () => [],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true);
    expect(data.total).toBe(0);
    expect(data.mutationScore).toBe(0); // score guard stays 0 for a 0 denominator
    expect(data.passed).toBe(true); // …yet vacuously adequate
    expect(data.trivialPass).toBe(true); // the explicit marker
  });

  it('Passed_DocsOnlyDiff_StillTrivialPasses', async () => {
    // The trivial pass must survive a diff that changed files no runner mutates,
    // or every docs/spec change starts degrading the required dimension.
    const { success, data } = await dispatchMutation({
      runDiff: () => ['docs/specs/plan.md', 'README.md', 'src/foo.test.ts'],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true);
    expect(data.trivialPass).toBe(true);
    expect(data.passed).toBe(true);
  });

  it('ZeroMutants_WhileTheDiffChangedMutatableSource_DegradesInsteadOfPassing', async () => {
    // The vacuous-pass hole. `total === 0` has two causes and they are NOT
    // interchangeable: nothing to mutate, or nothing was mutated. The required
    // HIGH-tier dimension reported adequacy in under 30ms over a diff touching 290
    // production modules because it read the second as the first, and emitted no
    // `skipped`, `reason` or `warning` to tell them apart. Corroborating the empty
    // surface against the diff is what makes the difference observable.
    const { success, data, warnings } = await dispatchMutation({
      runDiff: () => ['servers/exarchos-mcp/src/orchestrate/gate-runner.ts', 'src/advisory-registry.ts'],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true); // still a degrade, never a thrown envelope
    expect(data.trivialPass).toBeUndefined(); // NOT laundered as vacuously adequate
    const surfaced = [...(warnings ?? []), data.warning ?? ''].join(' ');
    expect(surfaced).toMatch(/ZERO mutants/i);
    // The reason has to name the run, not just complain — this is the line that
    // sends a reader to the actual cause.
    expect(surfaced).toMatch(/mutatable file/i);
  });

  it('FailureMessage_NoCoverageMutants_AttributesFileAndLine', async () => {
    // When the NoCoverage axis blocks, the failure message names each uncovered
    // mutant by file:line so the caller knows exactly what executes no test.
    const { data } = await dispatchMutation({
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'NoCoverage', file: 'src/util.ts', line: 7 },
          { status: 'NoCoverage', file: 'src/calc.ts', line: 42 },
        ]),
      },
    });
    expect(data.passed).toBe(false);
    expect(data.noCoverageReason).toBeDefined();
    expect(data.noCoverageReason).toContain('src/util.ts:7');
    expect(data.noCoverageReason).toContain('src/calc.ts:42');
  });

  it('FullScope_NoCoverageAxisInert_ScoreOnly', async () => {
    // The NoCoverage axis is a DIFF-scoped signal. A full-scope (offline) run
    // keeps the single score axis — NoCoverage mutants do not block there.
    const { data } = await dispatchMutation({
      scope: 'full',
      offline: true,
      runResult: {
        ok: true,
        report: strykerReport([
          { status: 'Killed', line: 1 },
          { status: 'Killed', line: 2 },
          { status: 'NoCoverage', line: 11 },
        ]),
      },
    });
    expect(data.noCoverage).toBe(1);
    // score = 2 / (3 − 1) = 1.0 >= threshold, and NoCoverage is inert at full scope.
    expect(data.passed).toBe(true);
  });

  it('Integration_HandlerEventFoldsToGuard_NoCoverageBlocks', async () => {
    // HIGH-rung cross-seam proof: the REAL handler emits a real gate.executed,
    // the REAL projection folds it into reviews['mutation-adequacy'] (carrying
    // noCoverage), and the REAL block-mode guard reads that folded state and
    // blocks — no mocks between the three collaborators.
    const { stateDir, eventStore } = await newStore();
    const mix = [
      { status: 'Killed', line: 1 },
      { status: 'Killed', line: 2 },
      { status: 'Killed', line: 3 },
      { status: 'Killed', line: 4 },
      { status: 'Killed', line: 5 },
      { status: 'NoCoverage', file: 'src/pay.ts', line: 21 },
      { status: 'NoCoverage', file: 'src/pay.ts', line: 22 },
      { status: 'NoCoverage', file: 'src/pay.ts', line: 23 },
      { status: 'NoCoverage', file: 'src/pay.ts', line: 24 },
      { status: 'NoCoverage', file: 'src/pay.ts', line: 25 },
    ];
    const { data } = await dispatchMutation({
      eventStore,
      stateDir,
      runResult: { ok: true, report: strykerReport(mix) },
    });
    // Handler axis: score 1.0 (UNCHANGED) yet failed on the NoCoverage axis.
    expect(data.mutationScore).toBeCloseTo(1.0, 5);
    expect(data.passed).toBe(false);

    // Fold the emitted events through the REAL projection.
    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    let view = workflowStateProjection.init();
    for (const e of events) view = workflowStateProjection.apply(view, e);
    const dim = (view.reviews as Record<string, { noCoverage?: number; mutationScore?: number }>)[
      'mutation-adequacy'
    ];
    expect(dim.noCoverage).toBe(5);
    expect(dim.mutationScore).toBeCloseTo(1.0, 5); // definition unchanged (INV-5b)

    // The REAL guard reads the folded state + the injected budget and blocks.
    const guardState = {
      reviews: view.reviews,
      _requiredReviews: ['mutation-adequacy'],
      _mutationEnforcement: 'block',
      _mutationThreshold: 0.4,
      _maxNoCoverage: 0,
    } as unknown as Record<string, unknown>;
    const verdict = guards.allReviewsPassed.evaluate(guardState);
    expect(verdict).not.toBe(true);
    expect((verdict as GuardFailure).reason).toContain('NoCoverage');
  });
});
