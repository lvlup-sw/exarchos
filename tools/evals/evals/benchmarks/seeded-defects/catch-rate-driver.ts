// ─── Gate catch-rate driver + measured cost columns (#1675, task 004) ─────────
//
// Drives the FIVE real mechanical gate HANDLERS over the DR-2 seeded-defect
// corpus and measures, per gate: true-positive catch rate on seeded defects and
// false-positive rate on matched controls — the enforcement-floor measurement
// #1670 left open. Per fixture × gate it also records the DR-5 cost columns:
// wall-clock milliseconds and gate-result payload tokens (the Pareto plane the
// gate-policy replay consumes).
//
// ── Method integrity (DR-8) ──────────────────────────────────────────────────
//  • REAL handlers, no self-reported verdicts: each fixture is materialized into
//    a DISPOSABLE git worktree and its class's production handler is called
//    directly (`handleTestAdequacy` / `handleStaticAnalysis` / …). Calling the
//    handler directly — not through the dispatch severity wrapper — yields the
//    RAW detection verdict, which is exactly what a catch rate must measure (the
//    workflow-severity adaptation is a dispatch-phase concern, not a gate's
//    detection power).
//  • EPHEMERAL event store only: the driver's `gate.executed` emissions land in a
//    throwaway store under the OS temp dir — NEVER the project event store.
//  • Block-diagonal fixture×gate matrix: the corpus is class-partitioned by
//    target gate, so each fixture is driven through its OWN class's gate (running
//    a mock-boundary gate over a contract fixture would be noise, not signal).
//    The dropped-edge-case class has NO gate — it is recorded as `ungated`
//    pass-through with its hidden-oracle verdict, feeding task 006's escape math.
//  • Fail-honest: a handler crash / non-success envelope yields an explicit
//    `invalid` record for that cell — never a fabricated verdict.
// ────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { EventStore } from '../../../../../src/events/store.js';
import type { ToolResult } from '../../../../../src/format.js';
import { handleTestAdequacy } from '../../../../../src/verbs/gates/test-adequacy-handler.js';
import { handleStaticAnalysis } from '../../../../../src/verbs/gates/static-analysis.js';
import { handleContractDrift } from '../../../../../src/verbs/gates/contract-drift-handler.js';
import { handleMockBoundary } from '../../../../../src/verbs/gates/mock-boundary-handler.js';
import { handleCheckIntegrationSuite } from '../../../../../src/verbs/gates/check-integration-suite.js';
import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
} from '../../../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../../src/dispatch/dispatch-context.js';
import {
  stampProvenance,
  assertMeasured,
  type Provenance,
  type ProvenanceStamped,
} from '../../provenance.js';
import {
  loadSeededCorpus,
  materializeFixture,
  runDroppedEdgeOracle,
  MECHANICAL_GATE_CLASSES,
  type GateClass,
  type GitRun,
  type MaterializedFixture,
  type SeededFixture,
} from './corpus.js';

// ─── Verdict + record shapes ──────────────────────────────────────────────────

/** The verdict a gate returned on a fixture cell. */
export type CellVerdict = 'fail' | 'pass' | 'invalid' | 'ungated';

/** One (fixture × its gate) measurement cell. */
export interface CatchRateRow {
  readonly gateClass: GateClass;
  readonly fixtureId: string;
  readonly kind: 'defect' | 'control';
  /** The gate action driven (or `none` for the ungated dropped-edge-case class). */
  readonly gate: string;
  /** The verdict a correct gate should return (`fail`/`pass`/`ungated`). */
  readonly expectedVerdict: string;
  /** The verdict the REAL gate actually returned. */
  readonly verdict: CellVerdict;
  /** True when `verdict` matched `expectedVerdict` (blank for ungated rows). */
  readonly correct: boolean | '';
  /** Measured wall-clock of the gate (or oracle) call, in milliseconds. */
  readonly wallClockMs: number;
  /** Exact serialized gate-result payload length (measured). */
  readonly payloadChars: number;
  /** ≈token count — `ceil(payloadChars / 4)`, a deterministic transform of the measured chars. */
  readonly payloadTokens: number;
  /** Classifier-derived risk tier (from the manifest). */
  readonly riskTier: string;
  /** Classifier-derived boundary flag (from the manifest). */
  readonly boundaryTouching: boolean;
  /** Hidden-oracle verdict for dropped-edge-case rows; blank for gated rows. */
  readonly oracleDetected: boolean | '';
  /** Discriminant / crash note when non-nominal (e.g. `invalid`, gate skip). */
  readonly note: string;
}

/** Per-gate aggregate over its class's fixtures. */
export interface GateAggregate {
  readonly gate: string;
  readonly gateClass: GateClass;
  readonly defects: number;
  readonly defectsCaught: number;
  /** True-positive catch rate on seeded defects (caught / defects). */
  readonly truePositiveRate: number;
  readonly controls: number;
  readonly falsePositives: number;
  /** False-positive rate on controls (false-positives / controls). */
  readonly falsePositiveRate: number;
  readonly invalidCells: number;
  readonly meanWallClockMs: number;
  readonly meanPayloadTokens: number;
}

export interface CatchRateReport {
  readonly rows: readonly CatchRateRow[];
  readonly aggregates: readonly GateAggregate[];
  /** The ephemeral event-store directory the run used (never the project store). */
  readonly eventStoreDir: string;
}

// ─── Handler map (block-diagonal: one gate per class) ─────────────────────────

/** A production gate handler: `(args, stateDir, eventStore) => ToolResult`. */
export type GateHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  eventStore: EventStore,
) => Promise<ToolResult>;

// Each production handler takes a narrowly-typed args object; the driver hands a
// generic record (built from the fixture), so wrap each in a thin adapter that
// casts at the single call boundary — the handlers validate their required
// fields (featureId/taskId) at runtime.
const GATE_HANDLERS: Readonly<Record<GateClass, GateHandler | null>> = {
  'test-adequacy': (a, sd, es) => handleTestAdequacy(a as unknown as Parameters<typeof handleTestAdequacy>[0], sd, es),
  'static-analysis': (a, sd, es) => handleStaticAnalysis(a as unknown as Parameters<typeof handleStaticAnalysis>[0], sd, es),
  'contract-drift': (a, sd, es) => handleContractDrift(a as unknown as Parameters<typeof handleContractDrift>[0], sd, es),
  'mock-boundary': (a, sd, es) => handleMockBoundary(a as unknown as Parameters<typeof handleMockBoundary>[0], sd, es),
  'integration-suite': (a, sd, es) => handleCheckIntegrationSuite(a as unknown as Parameters<typeof handleCheckIntegrationSuite>[0], sd, es),
  'dropped-edge-case': null,
};

// ─── Verdict extraction (gate-aware) ──────────────────────────────────────────

/** ≈token estimate: a deterministic transform of the MEASURED payload length. */
export function estimateTokens(payloadChars: number): number {
  return Math.ceil(payloadChars / 4);
}

/**
 * Map a real gate ToolResult to a catch-rate verdict, per the gate's own
 * signalling convention:
 *   • mock-boundary is ADVISORY (passed stays true) — a catch is `findings > 0`.
 *   • an inconclusive gate (skipped / parseError) is `invalid`, never pass/fail.
 *   • every other gate signals a catch via `data.passed === false`.
 * A non-success envelope or a missing `passed` is `invalid` (fail-honest).
 */
export function verdictFromResult(gateClass: GateClass, result: ToolResult): {
  verdict: CellVerdict;
  note: string;
} {
  if (!result || result.success !== true || result.data == null) {
    const code = result?.error?.code ? String(result.error.code) : 'no-data';
    return { verdict: 'invalid', note: `handler-envelope:${code}` };
  }
  const d = result.data as Record<string, unknown>;

  if (gateClass === 'mock-boundary') {
    const findings = Array.isArray(d.findings) ? d.findings : [];
    return { verdict: findings.length > 0 ? 'fail' : 'pass', note: `findings=${findings.length}` };
  }

  // Inconclusive verdicts are NOT a real pass/fail — record them as invalid so a
  // "no toolchain" skip or an unparseable suite never masquerades as a verdict.
  if (d.skipped === true) return { verdict: 'invalid', note: 'gate-skipped' };
  if (d.parseError === true) {
    return { verdict: 'invalid', note: `parse-error:${String(d.parseFailureKind ?? 'unknown')}` };
  }
  if (typeof d.passed !== 'boolean') return { verdict: 'invalid', note: 'no-passed-flag' };

  const note = typeof d.discriminant === 'string' ? d.discriminant : '';
  return { verdict: d.passed ? 'pass' : 'fail', note };
}

// ─── Real git executor (total: exit code is a value, never a throw) ───────────

const realGit: GitRun = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.toString(), exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { stdout: out, exitCode: e.status ?? 1 };
  }
};

// ─── Dispatch seam ────────────────────────────────────────────────────────────

/** Args passed to a gate handler for a materialized fixture. */
export interface GateArgs {
  readonly featureId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly repoRoot: string;
}

/**
 * The gate-dispatch seam: run a fixture's class handler over its materialized
 * worktree. Injected in tests to simulate a crash (throws → the driver records
 * an `invalid` cell). Default calls the real handler directly.
 */
export type GateDispatch = (
  fixture: SeededFixture,
  args: GateArgs,
  stateDir: string,
  eventStore: EventStore,
) => Promise<ToolResult>;

const defaultDispatch: GateDispatch = async (fixture, args, stateDir, eventStore) => {
  const handler = GATE_HANDLERS[fixture.gateClass];
  if (!handler) {
    return {
      success: false,
      error: { code: 'NO_GATE', message: `no gate for class ${fixture.gateClass}` },
    };
  }

  // The driver IS the transport for these handlers, so it must supply what a
  // transport supplies. The canonical gate runner reads caller authorization
  // from the ambient dispatch scope and binds evidence to an active phase
  // attempt; without both, every cell fails closed and the driver honestly
  // records `invalid` — which measures the harness, not the gate's detection
  // power. Uses the same primitives `dispatch/core/dispatch.ts` does so this cannot
  // drift from production plumbing.
  const featureId =
    typeof (args as { featureId?: unknown }).featureId === 'string'
      ? (args as { featureId: string }).featureId
      : undefined;
  if (featureId !== undefined) {
    const existing = await eventStore.query(featureId);
    if (existing.length === 0) {
      await eventStore.append(featureId, {
        type: 'workflow.started',
        data: {
          featureId,
          workflowType: 'feature',
          phase: 'delegate',
          // Corpus fixture ids are PATHS (`test-adequacy/defect-01`), but a
          // phase-attempt id is a schema-validated identity — an unflattened
          // `/` makes it malformed and the gate rejects the whole scope.
          phaseAttemptId: `phase-attempt:${featureId.replace(/\//g, '-')}`,
        },
      });
    }
  }

  const authorization = snapshotCallerAuthorization(
    deriveLocalOperatorIdentity(stateDir),
    undefined,
  );
  return runWithDispatchContext(mintDispatchContext(undefined, authorization), () =>
    handler({ ...args, action: fixture.manifest.gate }, stateDir, eventStore),
  );
};

// ─── Injectable dependencies ──────────────────────────────────────────────────

export interface CatchRateDeps {
  /** The corpus to drive (default: the full seeded corpus). */
  readonly corpus?: SeededFixture[];
  /** Root under which ALL ephemeral state is created (default: OS temp dir). */
  readonly tmpRoot?: string;
  /** Git executor (default: real git). */
  readonly git?: GitRun;
  /** Gate-dispatch seam (default: the real handlers). */
  readonly dispatch?: GateDispatch;
  /** Hidden-oracle runner for the dropped-edge-case class (default: real). */
  readonly oracle?: (fixture: SeededFixture) => { detected: boolean };
  /** Monotonic clock for wall-clock measurement (default: performance.now). */
  readonly now?: () => number;
}

// ─── Driver ───────────────────────────────────────────────────────────────────

/**
 * Drive the corpus through the real gates and return the per-cell rows +
 * per-gate aggregates. Creates ONE ephemeral event store under `tmpRoot` (never
 * the project store); each fixture is materialized into its own disposable
 * worktree that is torn down as soon as its gate runs. The event-store dir is
 * left in place for the caller to inspect/clean (it is always ephemeral).
 */
export async function runCatchRate(deps: CatchRateDeps = {}): Promise<CatchRateReport> {
  const corpus = deps.corpus ?? loadSeededCorpus();
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const git = deps.git ?? realGit;
  const dispatch = deps.dispatch ?? defaultDispatch;
  const oracle = deps.oracle ?? ((f: SeededFixture) => runDroppedEdgeOracle(f));
  const now = deps.now ?? (() => performance.now());

  fs.mkdirSync(tmpRoot, { recursive: true });
  const eventStoreDir = fs.mkdtempSync(path.join(tmpRoot, 'catch-rate-events-'));
  const eventStore = new EventStore(eventStoreDir);
  await eventStore.initialize();

  const rows: CatchRateRow[] = [];
  try {
    for (const fixture of corpus) {
      rows.push(await measureCell(fixture, { tmpRoot, git, dispatch, oracle, now, eventStore, eventStoreDir }));
    }
  } finally {
    eventStore.close();
  }

  return { rows, aggregates: aggregate(rows), eventStoreDir };
}

interface CellDeps {
  readonly tmpRoot: string;
  readonly git: GitRun;
  readonly dispatch: GateDispatch;
  readonly oracle: (fixture: SeededFixture) => { detected: boolean };
  readonly now: () => number;
  readonly eventStore: EventStore;
  readonly eventStoreDir: string;
}

async function measureCell(fixture: SeededFixture, deps: CellDeps): Promise<CatchRateRow> {
  const { manifest } = fixture;
  const common = {
    gateClass: fixture.gateClass,
    fixtureId: fixture.id,
    kind: fixture.kind,
    gate: manifest.gate ?? 'none',
    expectedVerdict: manifest.expectedVerdict,
    riskTier: manifest.riskTier,
    boundaryTouching: manifest.boundaryTouching,
  } as const;

  // Dropped-edge-case: NO production gate targets it — pass-through, graded by
  // the hidden oracle (feeds task 006's escape computation).
  if (fixture.gateClass === 'dropped-edge-case') {
    const t0 = deps.now();
    let detected = false;
    let note = 'ungated';
    try {
      detected = deps.oracle(fixture).detected;
    } catch (err) {
      note = `oracle-error:${err instanceof Error ? err.message : String(err)}`;
    }
    const wallClockMs = round2(deps.now() - t0);
    return {
      ...common,
      verdict: 'ungated',
      correct: '',
      wallClockMs,
      payloadChars: 0,
      payloadTokens: 0,
      oracleDetected: note.startsWith('oracle-error') ? '' : detected,
      note,
    };
  }

  // Mechanical gate cell: materialize → dispatch the real handler → measure.
  const worktree = fs.mkdtempSync(path.join(deps.tmpRoot, `cr-${fixture.gateClass}-`));
  try {
    let mat: MaterializedFixture;
    try {
      mat = materializeFixture(fixture, worktree, deps.git);
    } catch (err) {
      // A git setup failure → an explicit invalid cell, never a verdict off a
      // partial worktree (DR-8). Kept distinct from the handler-threw path.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ...common,
        verdict: 'invalid',
        correct: false,
        wallClockMs: 0,
        payloadChars: 0,
        payloadTokens: 0,
        oracleDetected: '',
        note: `materialize-failed:${msg}`,
      };
    }
    const args: GateArgs = {
      featureId: fixture.id,
      // Evidence subjects are schema-validated identities, and a corpus fixture
      // id is a PATH (`test-adequacy/defect-01`) — the `/` makes it malformed as
      // a taskId, which the gate rejects with INVALID_GATE_SCOPE. Flatten the
      // separator; the mapping stays injective, so cells remain distinguishable.
      taskId: fixture.id.replace(/\//g, '-'),
      branch: mat.branch,
      baseBranch: mat.baseBranch,
      repoRoot: worktree,
    };

    let result: ToolResult;
    let crashed: string | null = null;
    const t0 = deps.now();
    try {
      result = await deps.dispatch(fixture, args, deps.eventStoreDir, deps.eventStore);
    } catch (err) {
      crashed = err instanceof Error ? err.message : String(err);
      result = { success: false, error: { code: 'HANDLER_THREW', message: crashed } };
    }
    const wallClockMs = round2(deps.now() - t0);

    const payload = JSON.stringify(result.success ? result.data ?? {} : result.error ?? {});
    const payloadChars = payload.length;

    const { verdict, note } = crashed
      ? { verdict: 'invalid' as const, note: `handler-threw:${crashed}` }
      : verdictFromResult(fixture.gateClass, result);

    const correct = verdict === 'invalid' ? false : verdict === manifest.expectedVerdict;

    return {
      ...common,
      verdict,
      correct,
      wallClockMs,
      payloadChars,
      payloadTokens: estimateTokens(payloadChars),
      oracleDetected: '',
      note,
    };
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : round2(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/** Aggregate the per-cell rows into a per-gate catch-rate + cost summary. */
export function aggregate(rows: readonly CatchRateRow[]): GateAggregate[] {
  const out: GateAggregate[] = [];
  for (const gateClass of MECHANICAL_GATE_CLASSES) {
    const cls = rows.filter((r) => r.gateClass === gateClass);
    const defects = cls.filter((r) => r.kind === 'defect');
    const controls = cls.filter((r) => r.kind === 'control');
    const defectsCaught = defects.filter((r) => r.verdict === 'fail').length;
    const falsePositives = controls.filter((r) => r.verdict === 'fail').length;
    const invalidCells = cls.filter((r) => r.verdict === 'invalid').length;
    // Rates are over the CONCLUSIVE cells (invalid cells never inflate a rate).
    const conclDefects = defects.filter((r) => r.verdict !== 'invalid').length;
    const conclControls = controls.filter((r) => r.verdict !== 'invalid').length;
    out.push({
      gate: cls[0]?.gate ?? gateClass,
      gateClass,
      defects: defects.length,
      defectsCaught,
      truePositiveRate: conclDefects === 0 ? 0 : round2(defectsCaught / conclDefects),
      controls: controls.length,
      falsePositives,
      falsePositiveRate: conclControls === 0 ? 0 : round2(falsePositives / conclControls),
      invalidCells,
      meanWallClockMs: mean(cls.map((r) => r.wallClockMs)),
      meanPayloadTokens: mean(cls.map((r) => r.payloadTokens)),
    });
  }
  return out;
}

// ─── CSV serialization (provenance-stamped) ───────────────────────────────────

const CSV_COLUMNS: readonly (keyof CatchRateRow)[] = [
  'gateClass',
  'fixtureId',
  'kind',
  'gate',
  'expectedVerdict',
  'verdict',
  'correct',
  'riskTier',
  'boundaryTouching',
  'wallClockMs',
  'payloadChars',
  'payloadTokens',
  'oracleDetected',
  'note',
];

function csvField(v: unknown): string {
  const s = v === '' || v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize the report to CSV, provenance-stamped (DR-8). The stamp is validated
 * via {@link stampProvenance} (throws on incomplete provenance) and asserted
 * `measured` via {@link assertMeasured}, then written as `#`-comment header lines
 * (which the chart generator skips) so the committed CSV carries `{ binaryTag,
 * gitSha, modelIds, date }` + `source: measured` inline.
 */
export function toCsv(report: CatchRateReport, provenance: Provenance): string {
  const stamped: ProvenanceStamped<{ source: 'measured'; benchmark: string }> = stampProvenance(
    { source: 'measured' as const, benchmark: 'gate-catch-rate' },
    provenance,
  );
  assertMeasured(stamped);
  const p = stamped.provenance;

  const lines: string[] = [
    '# benchmark: gate-catch-rate (#1675 DR-3) — mechanical-gate catch rate + cost columns',
    `# source: ${stamped.source}`,
    `# binaryTag: ${p.binaryTag}`,
    `# gitSha: ${p.gitSha}`,
    `# modelIds: ${p.modelIds.join(';')}`,
    `# date: ${p.date}`,
    '# note: model-free — the mechanical gates are deterministic (no LLM); modelIds=[none] satisfies the provenance non-empty invariant. wallClockMs is a machine-dependent snapshot; payloadTokens = ceil(payloadChars/4).',
    CSV_COLUMNS.join(','),
  ];
  for (const row of report.rows) {
    lines.push(CSV_COLUMNS.map((c) => csvField(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ─── Script entry point (guarded — import-safe) ───────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const CSV_OUT = path.join(REPO_ROOT, 'tests/evals/data/2026-07-10/gate-catch-rate.csv');

function resolveProvenance(): Provenance {
  const git = realGit(REPO_ROOT, ['rev-parse', 'HEAD']);
  const gitSha = git.exitCode === 0 ? git.stdout.trim() : 'unknown';
  let binaryTag = 'unknown';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version?: string };
    if (pkg.version) binaryTag = `v${pkg.version}`;
  } catch {
    /* leave unknown */
  }
  // Fixed benchmark date (no ambient clock) so the committed CSV's provenance
  // header is stable across re-runs; the wall-clock ms columns carry the
  // machine-dependent snapshot instead.
  return { binaryTag, gitSha, modelIds: ['none'], date: '2026-07-10' };
}

async function main(): Promise<void> {
  process.stdout.write('Driving the seeded-defect corpus through the five real mechanical gates…\n');
  const report = await runCatchRate();
  const csv = toCsv(report, resolveProvenance());
  fs.mkdirSync(path.dirname(CSV_OUT), { recursive: true });
  fs.writeFileSync(CSV_OUT, csv);
  fs.rmSync(report.eventStoreDir, { recursive: true, force: true });

  process.stdout.write(`\nPer-gate catch-rate:\n`);
  for (const a of report.aggregates) {
    process.stdout.write(
      `  ${a.gate.padEnd(24)} TPR ${(a.truePositiveRate * 100).toFixed(0)}% (${a.defectsCaught}/${a.defects})` +
        `  FPR ${(a.falsePositiveRate * 100).toFixed(0)}% (${a.falsePositives}/${a.controls})` +
        `  invalid=${a.invalidCells}  ~${a.meanPayloadTokens}tok  ${a.meanWallClockMs}ms\n`,
    );
  }
  process.stdout.write(`\n[written] ${path.relative(REPO_ROOT, CSV_OUT)} (${report.rows.length} rows)\n`);
}

// Only run when invoked directly (`tsx catch-rate-driver.ts`); importing (tests)
// must not run main or write the CSV.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(HERE, 'catch-rate-driver.ts');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
    process.exit(1);
  });
}
