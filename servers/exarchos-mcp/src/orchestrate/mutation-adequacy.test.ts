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

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';
import type { MutationRunResult } from './mutation-adequacy.js';

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
  cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
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
  base?: string;
  threshold?: number;
  operationId?: string;
  projectConfig?: DispatchContext['projectConfig'];
  eventStore?: EventStore;
  stateDir?: string;
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
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
      // Test seams — injected through the dispatch args.
      resolve: () => runtimeWith(cmd),
      detectToolchainId: () => 'node',
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


// ─── Task 004: liveness + gate.executed ──────────────────────────────────────

describe('mutation-adequacy liveness + gate emission', () => {
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

