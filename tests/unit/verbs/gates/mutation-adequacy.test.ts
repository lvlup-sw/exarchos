/**
 * Dispatch-through tests for the `mutation-adequacy` action.
 *
 * Most tests dispatch through `handleOrchestrate`, because only such a test sees a registered action without a dispatch branch.
 * The other tests call the diff-scope, config-discovery, and run-root helpers directly.
 * No real Stryker or cargo-mutants process runs. Most tests inject the runner, and the real-runner tests spawn a small Node script.
 * The suite covers the handler and its degrade paths, the liveness events, the `next_actions` affordances, and the advisory verdict.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { orchestrateLogger } from '../../../../src/logger.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import type { ResolvedVerificationRuntime } from '../../../../src/config/test-runtime-resolver.js';
import { resolveConfig } from '../../../../src/config/resolve.js';
import type { ProjectConfig } from '../../../../src/config/yaml-schema.js';
import type { MutationRunResult, RunDiff } from '../../../../src/verbs/gates/mutation-adequacy.js';
import {
  composeScopedCommand,
  discoverMutationConfig,
  resolveMutationRunnerCwd,
} from '../../../../src/verbs/gates/mutation-adequacy.js';
import { foldInFlightOperations, type OperationEventLike } from '../../../../src/projections/views/lifecycle/operations-fold.js';
import { resolveMutationDiffScope } from '../../../../src/config/toolchains.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import { guards } from '../../../../src/workflow/guards.js';
import type { GuardFailure } from '../../../../src/workflow/guards.js';

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
  maxNoCoverage?: number;
  trivialPass?: boolean;
  noCoverageReason?: string;
  /** The run root. `runnerCwdRationale` and `mutationConfigPath` tell where it came from. */
  runnerCwd?: string;
  runnerCwdRationale?: string;
  mutationConfigPath?: string | null;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
    }
  }
});

/**
 * Creates a temporary repo root on disk. Keys are repo-relative POSIX paths, and the helper creates missing parent directories.
 * The files are real, because run-root resolution reads the filesystem.
 */
function makeRepoFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mutadq-repo-'));
  cleanups.push(() => rmrf(root));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** Minimal StrykerJS config body — only its NAME and location are load-bearing. */
const STRYKER_CONFIG = 'export default { testRunner: "vitest" };\n';

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
   * The diff seam. The default is "no files changed", which most cases mean when they give the runner a report directly.
   * An empty report is a trivial pass only when the diff changed nothing mutatable.
   * Thus the empty-surface cases must not depend on the real checkout.
   */
  runDiff?: (base: string, repoRoot: string) => readonly string[];
}

/** Dispatches `mutation-adequacy` through `handleOrchestrate`, with the test seams in the dispatch args. */
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

describe('mutation-adequacy action (dispatch-through handleOrchestrate)', () => {
  /** The score is killed divided by total minus NoCoverage: 2 / (4 - 1). The node toolchain adds `--since=main` to the command. */
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
    expect(data.killed).toBe(2);
    expect(data.survived).toBe(1);
    expect(data.noCoverage).toBe(1);
    expect(data.total).toBe(4);
    expect(data.mutationScore).toBeCloseTo(2 / 3, 5);
    expect(typeof data.passed).toBe('boolean');
    expect(data.report).toBeDefined();
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toContain('npx stryker run');
    expect(recordRuns[0]).toContain('--since=main');
  });

  /** A skip is not a failing verdict. The reason names a remediation path, and no runner runs. */
  it('HandleOrchestrate_MutationAdequacy_UnresolvedCommand_Skipped', async () => {
    const recordRuns: string[] = [];
    const { success, data } = await dispatchMutation({ mutationCmd: null, recordRuns });

    expect(success).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true);
    expect(typeof data.reason).toBe('string');
    expect(data.reason!.length).toBeGreaterThan(0);
    expect(recordRuns).toHaveLength(0);
  });

  /**
   * With no toolchain, the handler still emits a skip-pass `gate.executed`, so the projection records the review as skip-pass.
   * Otherwise review to synthesize deadlocks at the high tier on a repo with no mutation runner.
   * The skip-pass is not marked degraded, because that marker is for a runner that is present but broken.
   */
  it('HandleOrchestrate_MutationAdequacy_NoToolchain_EmitsSkipPassGateExecuted', async () => {
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
    expect(gd.details?.degraded).toBeUndefined();
  });

  /**
   * A malformed report degrades to a Warning carrier with `success: true`, not to an error envelope.
   * A degraded report has no score, so `passed` stays true.
   */
  it('HandleOrchestrate_MutationAdequacy_MalformedReport_Warning', async () => {
    const { success, data } = await dispatchMutation({
      runResult: { ok: true, report: 'not-json-at-all{' },
    });

    expect(success).toBe(true);
    expect(typeof data.warning).toBe('string');
    expect(data.warning!.length).toBeGreaterThan(0);
    expect(data.passed).toBe(true);
  });

  /**
   * A degrade with the toolchain present records a skip-pass marked `degraded: true`.
   * Thus block enforcement can fail closed while the advisory mode stays live.
   */
  it('HandleOrchestrate_MutationAdequacy_MalformedReport_EmitsDegradedSkipPass_RVC_R1', async () => {
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

  /** A runner crash (`ok: false`) is the other degrade path, and it is also marked `degraded: true`. */
  it('HandleOrchestrate_MutationAdequacy_RunnerFailure_EmitsDegradedSkipPass_RVC_R1', async () => {
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

  /**
   * The `gate.executed` key is the operationId with the outcome as a suffix.
   * Thus a degraded row does not suppress a later scored row for the same operationId.
   */
  it('HandleOrchestrate_MutationAdequacy_SameOperationId_DegradeThenScore_BothRowsPersist_RVC_R7', async () => {
    const { stateDir, eventStore } = await newStore();
    const op = 'op-shared-123';

    await dispatchMutation({
      runResult: { ok: true, report: 'not-json{' },
      operationId: op,
      eventStore,
      stateDir,
    });
    await dispatchMutation({
      runResult: { ok: true, report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }]) },
      operationId: op,
      eventStore,
      stateDir,
    });

    const mut = (await eventStore.query('feat-mutadq', { type: 'gate.executed' })).filter(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(mut.length).toBe(2);
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
    expect(recordRuns).toHaveLength(0);
  });

  /**
   * The explicit offline opt-in runs the whole tree with an unscoped command and gives a scored result, not the deferred advisory.
   * It also emits a foldable `gate.executed`.
   */
  it('HandleOrchestrate_MutationAdequacy_FullScopeOffline_RunsFullTreeScored', async () => {
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
    expect(data.deferred).toBeUndefined();
    expect(data.mutationScore).toBeCloseTo(2 / 3, 5);
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).toContain('npx stryker run');
    expect(recordRuns[0]).not.toContain('--since');
    const gates = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    expect(
      gates.some((e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy'),
    ).toBe(true);
  });

  /** Inline review never sets `offline`, so it never runs the full tree. */
  it('HandleOrchestrate_MutationAdequacy_FullScopeWithoutOffline_StaysDeferred', async () => {
    const recordRuns: string[] = [];
    const { data } = await dispatchMutation({ scope: 'full', offline: false, recordRuns });
    expect(data.deferred).toBe(true);
    expect(recordRuns).toHaveLength(0);
  });

  /** A registered action without a `handleOrchestrate` branch returns UNKNOWN_ACTION. */
  it('Registry_MutationAdequacyAction_HasHandlerBranch', async () => {
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
    if (result.success === false) {
      expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    }
    expect(result.success).toBe(true);
  });
});

/**
 * The tests above inject `runMutation`, so they do not run the production `defaultRunMutation`.
 * This test runs the real default against a child process that fails with a known stderr marker and no report on stdout.
 * The degrade reason must contain the marker, so the runner failure is attributable.
 */
describe('mutation-adequacy real runner — DR-10 stderr attribution (#1719)', () => {
  /** No `runMutation` seam is injected. The unknown toolchain has no diff-scope augmentation, so the command runs exactly as resolved. */
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
        resolve: () => runtimeWith(`${process.execPath} ${script}`),
        detectToolchainId: () => 'no-such-toolchain-xyz',
      },
      ctx,
    )) as { success: boolean; data: MutationData; warnings?: string[] };

    expect(result.success).toBe(true);
    expect(typeof result.data.warning).toBe('string');
    expect(result.data.warning).toContain(marker);
    expect(result.data.warning).toContain('mutation run produced no report');
  });
});

/** Dispatches the action for one detected toolchain and records the runs. The diff seam keeps the suite hermetic. */
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

/**
 * The applier `composeScopedCommand` fills the diff-scope descriptor from the injected `runDiff` seam.
 * PIT gets the changed Java classes, and mutmut gets the changed `.py` paths.
 * When the diff touches no file that it can scope, the applier falls back to the unscoped warning and never ships a literal `<changed>`.
 */
describe('mutation-adequacy diff-scope applier resolution', () => {
  it('MutationAdequacy_JavaScope_ResolvesChangedClasses_NoDegradeWarning', async () => {
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('java-maven', {
      recordRuns,
      runDiff: () => ['src/main/java/com/example/Calc.java'],
    });

    expect(success).toBe(true);
    expect(recordRuns).toHaveLength(1);
    expect(recordRuns[0]).not.toContain('<changed>');
    expect(recordRuns[0]).toContain('-DtargetClasses=com.example.Calc');
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
    expect(recordRuns[0]).toContain('--paths-to-mutate=');
    expect(recordRuns[0]).toContain('app/calc.py');
    expect(recordRuns[0]).toContain('app/util.py');
    expect(recordRuns[0]).not.toContain('<changed>');
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).not.toMatch(/unscoped|full-tree/i);
  });

  /**
   * A diff with no Java sources cannot be scoped.
   * The applier degrades to the unscoped warning and does not send an empty `-DtargetClasses=`.
   */
  it('MutationAdequacy_JavaScope_EmptyRelevantDiff_DegradesToWarning_NeverSilentFullTree', async () => {
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

  /** cargo-mutants already uses `--in-diff`, so the applier appends nothing and shows no warning. */
  it('MutationAdequacy_RustNativeScope_AppendsNothing_NoWarning', async () => {
    const recordRuns: string[] = [];
    const { success, warnings } = await dispatchForToolchain('rust', { recordRuns });

    expect(success).toBe(true);
    expect(recordRuns).toEqual(['mutate run']);
    const surfaced = (warnings ?? []).join(' ');
    expect(surfaced).not.toMatch(/unscoped|full-tree|path-restricted/i);
  });
});

/**
 * Calls the applier directly with a mocked `runDiff`, so no mutation run and no real git occur.
 * The descriptor comes from `resolveMutationDiffScope`.
 */
describe('composeScopedCommand diff-seam resolution (DR-5 / Gap C)', () => {
  const ctxWithDiff = (changed: readonly string[]) => ({
    base: 'main',
    repoRoot: '/repo',
    runDiff: (() => changed) as RunDiff,
  });

  it('Pit_ResolvesChangedPlaceholderToChangedClasses_NoDegradeWarning', () => {
    const scope = resolveMutationDiffScope('java-maven', 'main');
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
    expect(out.command).not.toContain('<changed>');
  });

  it('Mutmut_PathRestrictsToChangedPaths_NoDegradeWarning', () => {
    const scope = resolveMutationDiffScope('python', 'main');
    const out = composeScopedCommand(
      'mutmut run',
      scope,
      ctxWithDiff(['app/calc.py', 'app/util.py', 'README.md']),
    );

    expect(out.warning).toBeUndefined();
    expect(out.command).toContain('--paths-to-mutate=');
    expect(out.command).toContain('app/calc.py');
    expect(out.command).toContain('app/util.py');
    expect(out.command).not.toContain('README.md');
    expect(out.command).not.toContain('<changed>');
  });

  /** The Stryker `--since=<base>` flag has no `<changed>`, so the applier does not call the diff seam. */
  it('Stryker_AppendFlagWithoutPlaceholder_AppendsVerbatim_NeverCallsDiff', () => {
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
      ctxWithDiff(['docs/readme.md']),
    );

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
  /** The typo `dif` must not become `diff`. The handler rejects it before any runner work. */
  it('MutationAdequacy_InvalidScope_ReturnsInvalidInput_NeverRuns', async () => {
    const recordRuns: string[] = [];
    const { success, error } = await dispatchForToolchain('node', {
      scope: 'dif',
      recordRuns,
    });

    expect(success).toBe(false);
    expect(error?.code).toBe('INVALID_INPUT');
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
  /** The worktree is a real directory with a mutation config, because the reported run root must be a place where a runner can start. */
  it('MutationAdequacy_AutoRepoRoot_ResolvesFromWorktreeCreatedEvent', async () => {
    const { stateDir, eventStore } = await newStore();
    const worktree = makeRepoFixture({ 'stryker.conf.mjs': 'export default {};\n' });
    await eventStore.append('feat-mutadq', {
      type: 'worktree.created',
      data: { taskId: 'task-007', path: worktree },
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
    expect(seenRepoRoot).toBe(worktree);
  });

  /** `auto` without `taskId` or `worktreePath` cannot resolve, so the handler returns INVALID_INPUT and does not run. */
  it('MutationAdequacy_AutoRepoRoot_NoTaskIdNoWorktree_InvalidInput', async () => {
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

describe('mutation-adequacy liveness + gate emission', () => {
  /**
   * A liveness-emission failure must not fail a mutation run that succeeded, so the handler degrades without a throw.
   * `computeInFlightInstances` has no TTL, so a lost terminal event leaves the start in flight in `ps`.
   * Thus the handler logs a warning that names the terminal type and the instance. The spy fails only the terminal append.
   */
  it('MutationAdequacy_TerminalLivenessEmitFails_DegradesWithoutThrowingButLogsTrail', async () => {
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    const warn = vi.spyOn(orchestrateLogger, 'warn').mockImplementation(() => undefined);

    const realAppend = eventStore.append.bind(eventStore);
    vi.spyOn(eventStore, 'append').mockImplementation(
      async (stream: string, event: { type: string }) => {
        if (event.type === 'mutation.executed') throw new Error('append boom');
        return realAppend(stream, event);
      },
    );

    await expect(dispatchMutation({ eventStore, stateDir })).resolves.toBeDefined();

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

  /**
   * The injected seam can reject, and the terminal event must still land.
   * An unpaired `mutation.executing_started` keeps the run in flight: `ps` reports it and `wait --operation mutation` blocks to timeout.
   * The handler returns a coded `SCRIPT_ERROR`, not the generic INTERNAL_ERROR from the dispatch safety net.
   */
  it('MutationAdequacy_RunMutationRejects_StillEmitsPairedTerminalExecuted', async () => {
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCRIPT_ERROR');
    expect(result.error?.message).toContain('runner exploded');

    const events = await eventStore.query('feat-mutadq');
    const started = events.find((e) => e.type === 'mutation.executing_started');
    const executed = events.find((e) => e.type === 'mutation.executed');
    expect(started).toBeDefined();
    expect(executed).toBeDefined();
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

  /**
   * Both liveness events must carry a canonical `instanceId`, so `ps` can see a stuck run and a caller can wait for it.
   * A supplied operationId becomes the `instanceId`, and the terminal event clears the start in the fold.
   */
  it('MutationAdequacy_LivenessPair_CarriesCanonicalInstanceId_AndFoldsToPaired', async () => {
    const { stateDir, eventStore } = await newStore();
    await dispatchMutation({ eventStore, stateDir, operationId: 'op-mut-42' });

    const events = await eventStore.query('feat-mutadq');
    const start = events.find((e) => e.type === 'mutation.executing_started');
    const end = events.find((e) => e.type === 'mutation.executed');
    const startId = (start?.data as { instanceId?: unknown } | undefined)?.instanceId;
    const endId = (end?.data as { instanceId?: unknown } | undefined)?.instanceId;

    expect(typeof startId).toBe('string');
    expect((startId as string).length).toBeGreaterThan(0);
    expect(endId).toBe(startId);
    expect(startId).toBe('op-mut-42');

    const rows = foldInFlightOperations(events as unknown as OperationEventLike[]);
    expect(rows.some((r) => r.surface === 'mutation')).toBe(false);
  });

  /**
   * The test drops `mutation.executed` to model a crashed run.
   * The fold then shows the unpaired start, keyed by the `instanceId` and attributed to the feature stream.
   */
  it('MutationAdequacy_StuckRun_VisibleToOperationsFold_WithFeatureAttribution', async () => {
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

  /** A sequence of `gate.executed` rows folds into a score trend that does not decrease. */
  it('MutationAdequacy_GateExecuted_FoldsIntoScoreTrend', async () => {
    const { stateDir, eventStore } = await newStore();
    const scores = [0.4, 0.6, 0.8];
    for (const [i, killedCount] of [2, 3, 4].entries()) {
      const mutants = [
        ...Array.from({ length: killedCount }, () => ({ status: 'Killed' })),
        { status: 'Survived' },
      ];
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
    for (let i = 1; i < trend.length; i++) {
      expect(trend[i]).toBeGreaterThanOrEqual(trend[i - 1]);
    }
  });

  /** A retry under the same operationId collapses to one `gate.executed` row and does not throw a CAS conflict. */
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
    await expect(dispatchMutation(opts)).resolves.toBeDefined();

    const gates = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    const mutationGates = gates.filter(
      (e) => (e.data as { gateName?: string }).gateName === 'mutation-adequacy',
    );
    expect(mutationGates).toHaveLength(1);
  });

  function failGateExecutedAppends(eventStore: EventStore): void {
    const originalAppend = eventStore.append.bind(eventStore);
    vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
      if ((event as { type?: string }).type === 'gate.executed') {
        throw new Error('store unavailable');
      }
      return originalAppend(streamId, event, options);
    });
  }

  /**
   * The handler has three `gate.executed` append sites: the no-toolchain skip, the degraded result, and the scored result.
   * When an append fails at one of them, the handler withholds the success carrier. `data` still holds the verdict.
   */
  it('MutationAdequacy_GateEventAppendFails_WithholdsTheSuccessCarrier_SkipNoToolchain', async () => {
    const { stateDir, eventStore } = await newStore();
    failGateExecutedAppends(eventStore);

    const result = await dispatchMutation({ mutationCmd: null, eventStore, stateDir });

    expect(result.success).toBe(false);
    const error = (result as unknown as { error?: { code?: string } }).error;
    expect(error?.code).toBe('GATE_EVENT_UNRECORDED');
    expect(result.data.skipped).toBe(true);
    expect(result.data.passed).toBe(true);
  });

  it('MutationAdequacy_GateEventAppendFails_WithholdsTheSuccessCarrier_Degraded', async () => {
    const { stateDir, eventStore } = await newStore();
    failGateExecutedAppends(eventStore);

    const result = await dispatchMutation({
      runResult: { ok: false, reason: 'stryker exited 1' },
      eventStore,
      stateDir,
    });

    expect(result.success).toBe(false);
    const error = (result as unknown as { error?: { code?: string } }).error;
    expect(error?.code).toBe('GATE_EVENT_UNRECORDED');
    expect(result.data.passed).toBe(true);
  });

  it('MutationAdequacy_GateEventAppendFails_WithholdsTheSuccessCarrier_Scored', async () => {
    const { stateDir, eventStore } = await newStore();
    failGateExecutedAppends(eventStore);

    const result = await dispatchMutation({
      eventStore,
      stateDir,
      runResult: {
        ok: true,
        report: strykerReport([{ status: 'Killed' }, { status: 'Killed' }, { status: 'Survived' }]),
      },
    });

    expect(result.success).toBe(false);
    const error = (result as unknown as { error?: { code?: string } }).error;
    expect(error?.code).toBe('GATE_EVENT_UNRECORDED');
    expect(result.data.mutationScore).toBeCloseTo(2 / 3, 5);
  });
});

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

function configWith(overrides: Partial<ProjectConfig>): DispatchContext['projectConfig'] {
  return resolveConfig(overrides as ProjectConfig);
}

describe('mutation-adequacy advisory verdict + threshold', () => {
  /**
   * One killed mutant of three detectable mutants scores 0.33, below the 0.40 default.
   * The verdict is `passed: false` but advisory, with no error envelope.
   */
  it('MutationAdequacy_ScoreBelowThreshold_PassedFalseButAdvisory', async () => {
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
    expect(result.data.mutationScore).toBeLessThan(0.4);
  });

  /** An explicit `review.gates` override raises the severity to blocking, so no warning-only downgrade appears. */
  it('MutationAdequacy_ExplicitOverride_Blocking', async () => {
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
    const warnings = (result as { warnings?: string[] }).warnings ?? [];
    expect(warnings.some((w) => /warning-only/.test(w))).toBe(false);
  });

  /**
   * Without threshold config, the soft default applies.
   * The warning-only downgrade sets `data.passed` to true and carries the finding as a warning, because `passed: false` blocks the dispatch.
   */
  it('MutationAdequacy_NoThresholdConfig_DefaultsToSoftAdvisory', async () => {
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

/**
 * `mutationScore = killed / (total − noCoverage)` stays the same.
 * For a diff-scoped run, the handler also requires `noCoverage <= maxNoCoverage`, with a default of 0.
 * An empty mutatable surface (`total === 0`) is a trivial pass.
 */
describe('mutation-adequacy NoCoverage axis (DR-6)', () => {
  /**
   * Five killed and five NoCoverage mutants give a score of 1.0.
   * The NoCoverage axis, with a budget of 0, fails the run, and the score stays the same.
   */
  it('Passed_DiffScopeKilledPlusNoCoverageMix_Fails', async () => {
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
    expect(data.mutationScore).toBeCloseTo(1.0, 5);
    expect(data.noCoverage).toBe(5);
    expect(data.passed).toBe(false);
    expect(data.maxNoCoverage).toBe(0);
  });

  /** An all-covered diff at the same score of 1.0 still passes. */
  it('Passed_AllCoveredAtThreshold_PassesUnchanged', async () => {
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

  /** With a budget of 2, two NoCoverage mutants pass and a third fails. */
  it('Passed_NoCoverageWithinExplicitBudget_Passes', async () => {
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

  /**
   * With `total === 0` and an empty diff, the result is a trivial pass with an explicit marker, not a score-0 failure or a degrade.
   * The score stays 0 for a zero denominator. The empty `runDiff` keeps the case independent of the checkout.
   */
  it('Passed_EmptyMutatableSurface_TrivialPassWithMarker', async () => {
    const { success, data } = await dispatchMutation({
      runDiff: () => [],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true);
    expect(data.total).toBe(0);
    expect(data.mutationScore).toBe(0);
    expect(data.passed).toBe(true);
    expect(data.trivialPass).toBe(true);
  });

  /** A diff with only files that no runner mutates must still give a trivial pass, or each docs change degrades the required dimension. */
  it('Passed_DocsOnlyDiff_StillTrivialPasses', async () => {
    const { success, data } = await dispatchMutation({
      runDiff: () => ['docs/specs/plan.md', 'README.md', 'src/foo.test.ts'],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true);
    expect(data.trivialPass).toBe(true);
    expect(data.passed).toBe(true);
  });

  /**
   * `total === 0` has two causes: nothing to mutate, or nothing was mutated.
   * Here the diff changed mutatable source, so the handler degrades and does not report a trivial pass.
   * The warning names the mutatable files, so a reader can find the cause.
   */
  it('ZeroMutants_WhileTheDiffChangedMutatableSource_DegradesInsteadOfPassing', async () => {
    const { success, data, warnings } = await dispatchMutation({
      runDiff: () => ['src/verbs/gates/gate-runner.ts', 'src/advisory-registry.ts'],
      runResult: { ok: true, report: JSON.stringify({ schemaVersion: '1', files: {} }) },
    });
    expect(success).toBe(true);
    expect(data.trivialPass).toBeUndefined();
    const surfaced = [...(warnings ?? []), data.warning ?? ''].join(' ');
    expect(surfaced).toMatch(/ZERO mutants/i);
    expect(surfaced).toMatch(/mutatable file/i);
  });

  /** When the NoCoverage axis blocks, the failure message names each uncovered mutant by `file:line`. */
  it('FailureMessage_NoCoverageMutants_AttributesFileAndLine', async () => {
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

  /** The NoCoverage axis applies only to a diff-scoped run. A full-scope offline run keeps only the score axis. */
  it('FullScope_NoCoverageAxisInert_ScoreOnly', async () => {
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
    expect(data.passed).toBe(true);
  });

  /**
   * The real handler emits `gate.executed`, the real projection folds it into `reviews['mutation-adequacy']`, and the real block-mode guard blocks.
   * No mocks sit between the three.
   */
  it('Integration_HandlerEventFoldsToGuard_NoCoverageBlocks', async () => {
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
    expect(data.mutationScore).toBeCloseTo(1.0, 5);
    expect(data.passed).toBe(false);

    const events = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    let view = workflowStateProjection.init();
    for (const e of events) view = workflowStateProjection.apply(view, e);
    const dim = (view.reviews as Record<string, { noCoverage?: number; mutationScore?: number }>)[
      'mutation-adequacy'
    ];
    expect(dim.noCoverage).toBe(5);
    expect(dim.mutationScore).toBeCloseTo(1.0, 5);

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

/** Dispatch against a real on-disk repo root, capturing the runner's cwd. */
async function dispatchInRepo(
  repoRoot: string,
  opts: {
    mutationCmd?: string;
    projectConfig?: DispatchContext['projectConfig'];
    runDiff?: RunDiff;
  } = {},
): Promise<{
  success: boolean;
  data: MutationData;
  warnings?: string[];
  seenCwd: string | undefined;
  ran: boolean;
}> {
  const { stateDir, eventStore } = await newStore();
  const ctx = makeCtx(stateDir, eventStore, opts.projectConfig);
  let seenCwd: string | undefined;
  let ran = false;
  const result = (await handleOrchestrate(
    {
      action: 'mutation-adequacy',
      featureId: 'feat-mutadq',
      base: 'main',
      repoRoot,
      resolve: () => runtimeWith(opts.mutationCmd ?? 'npx stryker run'),
      detectToolchainId: () => 'node',
      runDiff: opts.runDiff ?? ((): readonly string[] => []),
      runMutation: (runArgs: { command: string; cwd: string }) => {
        ran = true;
        seenCwd = runArgs.cwd;
        return { ok: true as const, report: strykerReport([{ status: 'Killed' }]) };
      },
    },
    ctx,
  )) as { success: boolean; data: MutationData; warnings?: string[] };
  return { ...result, seenCwd, ran };
}

/**
 * The gate measures the tree where the runner runs, so the run root comes from the location of the mutation config.
 * Each fixture puts the config under a package name that the production module does not contain, so a constant run root cannot pass.
 */
describe('mutation config discovery (DR-8 — location, not a package name)', () => {
  it('DiscoverMutationConfig_ConfigInSubPackage_ResolvesThatPackageAsOwner', () => {
    const root = makeRepoFixture({
      'package.json': '{}',
      'services/billing-engine/stryker.conf.mjs': STRYKER_CONFIG,
      'services/billing-engine/src/pay.ts': 'export const x = 1;\n',
    });
    const found = discoverMutationConfig(root);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.packageDir).toBe(path.join(root, 'services', 'billing-engine'));
    expect(path.basename(found.configPath)).toBe('stryker.conf.mjs');
  });

  /** Moving the config moves the run root, with no source change. */
  it('DiscoverMutationConfig_MovingTheConfig_MovesTheOwner', () => {
    const before = makeRepoFixture({ 'apps/api/stryker.conf.mjs': STRYKER_CONFIG });
    const after = makeRepoFixture({ 'tooling/mutation/stryker.conf.mjs': STRYKER_CONFIG });
    const a = discoverMutationConfig(before);
    const b = discoverMutationConfig(after);
    expect(a.ok && path.relative(before, a.packageDir)).toBe(path.join('apps', 'api'));
    expect(b.ok && path.relative(after, b.packageDir)).toBe(path.join('tooling', 'mutation'));
  });

  /** A config inside a dependency tree or build output is not the project config. The scan root stays the whole repository. */
  it('DiscoverMutationConfig_DependencyAndBuildOutput_ExcludedByProperty', () => {
    const root = makeRepoFixture({
      'node_modules/some-dep/stryker.conf.js': STRYKER_CONFIG,
      'dist/stryker.conf.js': STRYKER_CONFIG,
      '.stryker-tmp/sandbox-1/stryker.conf.js': STRYKER_CONFIG,
      'src/index.ts': 'export const x = 1;\n',
    });
    expect(discoverMutationConfig(root).ok).toBe(false);
  });

  it('DiscoverMutationConfig_ShallowestWins_Deterministically', () => {
    const root = makeRepoFixture({
      'stryker.conf.mjs': STRYKER_CONFIG,
      'packages/zeta/stryker.conf.mjs': STRYKER_CONFIG,
      'packages/alpha/stryker.conf.mjs': STRYKER_CONFIG,
    });
    const found = discoverMutationConfig(root);
    expect(found.ok && found.packageDir).toBe(path.resolve(root));
  });

  /** Each Python package has a `pyproject.toml`, so the file name proves nothing. Only the runner section makes it a mutation config. */
  it('DiscoverMutationConfig_SharedFile_NeedsTheRunnersOwnSection', () => {
    const without = makeRepoFixture({ 'pyproject.toml': '[project]\nname = "x"\n' });
    const withSection = makeRepoFixture({
      'pkg/pyproject.toml': '[project]\nname = "x"\n\n[tool.mutmut]\npaths_to_mutate = "src/"\n',
    });
    expect(discoverMutationConfig(without).ok).toBe(false);
    const found = discoverMutationConfig(withSection);
    expect(found.ok && path.relative(withSection, found.packageDir)).toBe('pkg');
  });
});

describe('mutation runner cwd resolution (DR-8)', () => {
  it('ResolveRunnerCwd_ConfigInSubPackage_RunsThere', () => {
    const root = makeRepoFixture({ 'packages/engine/stryker.conf.mjs': STRYKER_CONFIG });
    const resolved = resolveMutationRunnerCwd({ command: 'npx stryker run', repoRoot: root });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.cwd).toBe(path.join(path.resolve(root), 'packages', 'engine'));
    expect(resolved.rationale).toBe('config-owner');
  });

  /**
   * A command whose entry point resolves only from the repo root is a project seam.
   * When it runs in another directory, it misses its own file or runs against the wrong tree.
   */
  it('ResolveRunnerCwd_RepoRootAnchoredCommand_StaysAtRepoRoot', () => {
    const root = makeRepoFixture({
      'packages/engine/stryker.conf.mjs': STRYKER_CONFIG,
      'tools/mutation/run.mjs': '// adapter\n',
    });
    const resolved = resolveMutationRunnerCwd({
      command: 'node tools/mutation/run.mjs --since=main',
      repoRoot: root,
    });
    expect(resolved.ok && resolved.cwd).toBe(path.resolve(root));
    expect(resolved.ok && resolved.rationale).toBe('repo-root-anchored-command');
  });

  it('ResolveRunnerCwd_NoConfigAnywhere_IsARefusal_NotAGuess', () => {
    const root = makeRepoFixture({ 'src/index.ts': 'export const x = 1;\n' });
    const resolved = resolveMutationRunnerCwd({ command: 'npx stryker run', repoRoot: root });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/no mutation-runner configuration was found/i);
    expect(resolved.reason).toMatch(/runnerDir/);
  });

  /**
   * The refusal above applies to an inferred command whose config cannot be found.
   * A project that declares the command itself already says how mutation testing runs, and many runners have no config file.
   * The same tree with an inferred command is still a refusal, so the declaration decides the result.
   */
  it('ResolveRunnerCwd_NoConfigButProjectDeclaredCommand_RunsAtRepoRoot', () => {
    const root = makeRepoFixture({ 'src/index.ts': 'export const x = 1;\n' });
    const resolved = resolveMutationRunnerCwd({
      command: 'node ./run-mutants.mjs',
      repoRoot: root,
      projectDeclaredCommand: true,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.cwd).toBe(path.resolve(root));
    expect(resolved.ok && resolved.rationale).toBe('declared-command');

    const inferred = resolveMutationRunnerCwd({
      command: 'node ./run-mutants.mjs',
      repoRoot: root,
    });
    expect(inferred.ok).toBe(false);
  });

  /** `runnerDir` is the escape hatch for a runner that needs no config file, such as cargo-mutants. */
  it('ResolveRunnerCwd_DeclaredRunnerDir_WinsOverDiscovery', () => {
    const root = makeRepoFixture({
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'packages/engine/stryker.conf.mjs': STRYKER_CONFIG,
    });
    const resolved = resolveMutationRunnerCwd({
      command: 'cargo mutants --in-diff',
      repoRoot: root,
      declaredRunnerDir: 'crates/core',
    });
    expect(resolved.ok && resolved.cwd).toBe(path.join(path.resolve(root), 'crates', 'core'));
    expect(resolved.ok && resolved.rationale).toBe('declared-runner-dir');
  });

  it('ResolveRunnerCwd_DeclaredRunnerDirMissing_Degrades', () => {
    const root = makeRepoFixture({ 'stryker.conf.mjs': STRYKER_CONFIG });
    const resolved = resolveMutationRunnerCwd({
      command: 'npx stryker run',
      repoRoot: root,
      declaredRunnerDir: 'crates/gone',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toMatch(/does not exist/i);
  });

  /**
   * `runnerDir` is relative to the repo root. The resolver refuses an absolute path or a `..` climb that leaves the repo, also when the target exists.
   * A sibling directory with the repo name as a prefix is also outside, because the check uses the path separator.
   * The in-repo case `.` still resolves.
   */
  it('ResolveRunnerCwd_DeclaredRunnerDirEscapingTheRepo_IsRefused', () => {
    const root = makeRepoFixture({ 'stryker.conf.mjs': STRYKER_CONFIG });
    const escapes = [path.resolve(root, '..'), '..', '../..', path.resolve(os.tmpdir())];

    for (const declaredRunnerDir of escapes) {
      const resolved = resolveMutationRunnerCwd({
        command: 'npx stryker run',
        repoRoot: root,
        declaredRunnerDir,
      });
      expect(resolved.ok, `${declaredRunnerDir} was accepted`).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toMatch(/outside/i);
    }

    const sibling = `${path.resolve(root)}-other`;
    const siblingResolved = resolveMutationRunnerCwd({
      command: 'npx stryker run',
      repoRoot: root,
      declaredRunnerDir: sibling,
    });
    expect(siblingResolved.ok).toBe(false);

    const inside = resolveMutationRunnerCwd({
      command: 'npx stryker run',
      repoRoot: root,
      declaredRunnerDir: '.',
    });
    expect(inside.ok).toBe(true);
  });
});

describe('mutation-adequacy run root — handler path (DR-8)', () => {
  /** The carrier reports the run root, so a reader can check the reach of the gate. */
  it('MutationAdequacy_ConfigInSubPackage_RunnerLaunchedThere_NotAtRepoRoot', async () => {
    const root = makeRepoFixture({
      'package.json': '{"name":"root"}',
      'services/billing-engine/stryker.conf.mjs': STRYKER_CONFIG,
    });
    const { success, data, seenCwd } = await dispatchInRepo(root);

    expect(success).toBe(true);
    expect(seenCwd).toBe(path.join(path.resolve(root), 'services', 'billing-engine'));
    expect(seenCwd).not.toBe(path.resolve(root));
    expect(data.runnerCwd).toBe('services/billing-engine');
    expect(data.runnerCwdRationale).toBe('config-owner');
    expect(data.mutationConfigPath).toBe('services/billing-engine/stryker.conf.mjs');
  });

  it('MutationAdequacy_ConfigAtRepoRoot_RunnerLaunchedAtRepoRoot', async () => {
    const root = makeRepoFixture({ 'stryker.conf.mjs': STRYKER_CONFIG });
    const { data, seenCwd } = await dispatchInRepo(root);
    expect(seenCwd).toBe(path.resolve(root));
    expect(data.runnerCwd).toBe('.');
    expect(data.runnerCwdRationale).toBe('config-at-repo-root');
  });

  it('MutationAdequacy_DeclaredRunnerDir_RunnerLaunchedThere', async () => {
    const root = makeRepoFixture({
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'packages/engine/stryker.conf.mjs': STRYKER_CONFIG,
    });
    const projectConfig = resolveConfig(
      {
        review: { gates: { 'mutation-adequacy': { params: { runnerDir: 'crates/core' } } } },
      } as unknown as ProjectConfig,
      root,
    );
    const { data, seenCwd } = await dispatchInRepo(root, {
      mutationCmd: 'cargo mutants --in-diff',
      projectConfig,
    });
    expect(seenCwd).toBe(path.join(path.resolve(root), 'crates', 'core'));
    expect(data.runnerCwdRationale).toBe('declared-runner-dir');
  });

  /**
   * The test runs one repo twice. With the config in place, the gate runs and scores.
   * After the config moves into an excluded dot-directory, the gate must not run, and it must not report adequacy.
   */
  it('MutationAdequacy_MovingTheMutationConfig_Degrades_NeverSilentlyPasses', async () => {
    const root = makeRepoFixture({
      'package.json': '{"name":"root"}',
      'services/billing-engine/stryker.conf.mjs': STRYKER_CONFIG,
    });

    const before = await dispatchInRepo(root);
    expect(before.ran).toBe(true);
    expect(before.data.total).toBeGreaterThan(0);
    expect(before.data.passed).toBe(true);

    mkdirSync(path.join(root, '.attic'), { recursive: true });
    renameSync(
      path.join(root, 'services', 'billing-engine', 'stryker.conf.mjs'),
      path.join(root, '.attic', 'stryker.conf.mjs'),
    );

    const after = await dispatchInRepo(root);
    expect(after.ran).toBe(false);
    expect(after.success).toBe(true);
    const surfaced = [...(after.warnings ?? []), after.data.warning ?? ''].join(' ');
    expect(surfaced).toMatch(/no mutation-runner configuration was found/i);
    expect(after.data.trivialPass).toBeUndefined();
    expect(after.data.total).toBe(0);
    expect(after.data.mutationScore).toBe(0);
  });

  /**
   * With no config, the gate row is `{ skipped, degraded }`, so block-mode enforcement can fail closed.
   * Nothing starts, so no liveness event exists.
   */
  it('MutationAdequacy_NoConfig_DegradeIsRecordedAsDegradedNotAScore', async () => {
    const root = makeRepoFixture({ 'src/index.ts': 'export const x = 1;\n' });
    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        repoRoot: root,
        resolve: () => runtimeWith('npx stryker run'),
        detectToolchainId: () => 'node',
        runDiff: (): readonly string[] => [],
      },
      ctx,
    );

    const gates = await eventStore.query('feat-mutadq', { type: 'gate.executed' });
    expect(gates).toHaveLength(1);
    const row = gates[0]!.data as {
      gateName?: string;
      passed?: boolean;
      details?: { skipped?: boolean; degraded?: boolean; reason?: string };
    };
    expect(row.gateName).toBe('mutation-adequacy');
    expect(row.details?.skipped).toBe(true);
    expect(row.details?.degraded).toBe(true);
    expect(row.details?.reason).toMatch(/no mutation-runner configuration was found/i);

    const liveness = await eventStore.query('feat-mutadq', { type: 'mutation.executing_started' });
    expect(liveness).toHaveLength(0);
  });
});

describe('mutation-adequacy real runner — cwd is the config package (DR-8)', () => {
  /**
   * The real `defaultRunMutation` spawns a child that reports its own `process.cwd()` as the mutated file.
   * The script path is absolute, so it is not a repo-root-anchored command, and the config package wins.
   */
  it('RealRunner_ShellsOutInTheConfigPackage_ProvenByTheChildsOwnCwd', async () => {
    const root = makeRepoFixture({
      'package.json': '{"name":"root"}',
      'services/billing-engine/stryker.conf.mjs': STRYKER_CONFIG,
    });
    const scriptDir = mkdtempSync(path.join(os.tmpdir(), 'mutadq-runner-'));
    cleanups.push(() => rmrf(scriptDir));
    const script = path.join(scriptDir, 'echo-cwd-runner.mjs');
    writeFileSync(
      script,
      'const report = { schemaVersion: "1", files: { [process.cwd()]: { language: "typescript", ' +
        'mutants: [{ id: "m0", mutatorName: "X", status: "Killed", location: { start: { line: 1, ' +
        'column: 1 }, end: { line: 1, column: 2 } } }] } } };\n' +
        'process.stdout.write(JSON.stringify(report));\n',
    );

    const { stateDir, eventStore } = await newStore();
    const ctx = makeCtx(stateDir, eventStore);
    const result = (await handleOrchestrate(
      {
        action: 'mutation-adequacy',
        featureId: 'feat-mutadq',
        base: 'main',
        repoRoot: root,
        resolve: () => runtimeWith(`${process.execPath} ${script}`),
        detectToolchainId: () => 'no-such-toolchain-xyz',
        runDiff: (): readonly string[] => [],
      },
      ctx,
    )) as { success: boolean; data: MutationData };

    const expected = path.join(path.resolve(root), 'services', 'billing-engine');
    const report = result.data.report as { files: Record<string, unknown> };
    expect(Object.keys(report.files)).toEqual([expected]);
    expect(result.data.total).toBe(1);
    expect(result.data.killed).toBe(1);
    expect(result.data.runnerCwd).toBe('services/billing-engine');
  });
});
