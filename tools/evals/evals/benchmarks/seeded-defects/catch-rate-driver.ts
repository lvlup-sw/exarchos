/**
 * The gate catch-rate driver. It runs the five mechanical gate handlers over the seeded-defect corpus.
 *
 * For each gate it measures the catch rate on seeded defects and the false-positive rate on controls. For
 * each fixture it records the wall-clock time and an estimated token count of the gate result.
 *
 * Each fixture gets a disposable git worktree, and the driver calls the handler of its class directly. A
 * direct call gives the raw detection verdict, without the severity wrapper of dispatch. The
 * `dropped-edge-case` class has no gate, so the hidden oracle grades it. Events go to a temporary event
 * store, never to the project store. A handler crash or a non-success result gives an `invalid` cell.
 */

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

/** The verdict a gate returned on a fixture cell. */
export type CellVerdict = 'fail' | 'pass' | 'invalid' | 'ungated';

/** One (fixture × its gate) measurement cell. */
export interface CatchRateRow {
  readonly gateClass: GateClass;
  readonly fixtureId: string;
  readonly kind: 'defect' | 'control';
  /** The gate action driven (or `none` for the ungated dropped-edge-case class). */
  readonly gate: string;
  /** The verdict that a correct gate returns (`fail`, `pass`, or `ungated`). */
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
  /** The hidden-oracle verdict for a `dropped-edge-case` row. It is blank for a gated row and when the oracle throws. */
  readonly oracleDetected: boolean | '';
  /** A short note: the gate discriminant, the finding count, the reason for an `invalid` cell, or the oracle status of an ungated row. */
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

/** A production gate handler: `(args, stateDir, eventStore) => ToolResult`. */
export type GateHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  eventStore: EventStore,
) => Promise<ToolResult>;

/**
 * Maps each class to its production handler. Each handler takes a narrow args type, so each adapter casts
 * the generic record from the fixture at this one boundary.
 */
const GATE_HANDLERS: Readonly<Record<GateClass, GateHandler | null>> = {
  'test-adequacy': (a, sd, es) => handleTestAdequacy(a as unknown as Parameters<typeof handleTestAdequacy>[0], sd, es),
  'static-analysis': (a, sd, es) => handleStaticAnalysis(a as unknown as Parameters<typeof handleStaticAnalysis>[0], sd, es),
  'contract-drift': (a, sd, es) => handleContractDrift(a as unknown as Parameters<typeof handleContractDrift>[0], sd, es),
  'mock-boundary': (a, sd, es) => handleMockBoundary(a as unknown as Parameters<typeof handleMockBoundary>[0], sd, es),
  'integration-suite': (a, sd, es) => handleCheckIntegrationSuite(a as unknown as Parameters<typeof handleCheckIntegrationSuite>[0], sd, es),
  'dropped-edge-case': null,
};

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

  if (d.skipped === true) return { verdict: 'invalid', note: 'gate-skipped' };
  if (d.parseError === true) {
    return { verdict: 'invalid', note: `parse-error:${String(d.parseFailureKind ?? 'unknown')}` };
  }
  if (typeof d.passed !== 'boolean') return { verdict: 'invalid', note: 'no-passed-flag' };

  const note = typeof d.discriminant === 'string' ? d.discriminant : '';
  return { verdict: d.passed ? 'pass' : 'fail', note };
}

/** Runs git and returns the exit code as a value. It never throws. */
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

/** Args passed to a gate handler for a materialized fixture. */
export interface GateArgs {
  readonly featureId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly repoRoot: string;
}

/**
 * Runs the class handler of a fixture over its materialized worktree. Tests inject a seam that throws to
 * simulate a crash, and the driver then records an `invalid` cell.
 */
export type GateDispatch = (
  fixture: SeededFixture,
  args: GateArgs,
  stateDir: string,
  eventStore: EventStore,
) => Promise<ToolResult>;

/**
 * Calls the real handler, and supplies what a transport supplies: a caller authorization in the dispatch
 * scope and an active phase attempt. Without both, every cell fails closed as `invalid`. The phase-attempt
 * id replaces each `/` of the fixture id with `-`, because the identity schema rejects `/`.
 */
const defaultDispatch: GateDispatch = async (fixture, args, stateDir, eventStore) => {
  const handler = GATE_HANDLERS[fixture.gateClass];
  if (!handler) {
    return {
      success: false,
      error: { code: 'NO_GATE', message: `no gate for class ${fixture.gateClass}` },
    };
  }

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

/**
 * Runs the corpus through the real gates and returns the rows and the per-gate aggregates. It makes one
 * temporary event store under `tmpRoot`, never the project store. Each fixture gets its own worktree, which
 * the driver removes after the gate runs. The event-store directory stays for the caller to read or remove.
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

/**
 * Measures one fixture. The hidden oracle grades a `dropped-edge-case` fixture, because no production gate
 * targets it. A failed git setup gives an `invalid` cell, never a verdict from a partial worktree. The
 * `taskId` replaces each `/` of the fixture id with `-`, because the gate rejects `/` with `INVALID_GATE_SCOPE`.
 */
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

  const worktree = fs.mkdtempSync(path.join(deps.tmpRoot, `cr-${fixture.gateClass}-`));
  try {
    let mat: MaterializedFixture;
    try {
      mat = materializeFixture(fixture, worktree, deps.git);
    } catch (err) {
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

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : round2(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/**
 * Aggregates the rows into a per-gate catch rate and cost summary. The rates count only conclusive cells,
 * so an `invalid` cell is not in a denominator.
 */
export function aggregate(rows: readonly CatchRateRow[]): GateAggregate[] {
  const out: GateAggregate[] = [];
  for (const gateClass of MECHANICAL_GATE_CLASSES) {
    const cls = rows.filter((r) => r.gateClass === gateClass);
    const defects = cls.filter((r) => r.kind === 'defect');
    const controls = cls.filter((r) => r.kind === 'control');
    const defectsCaught = defects.filter((r) => r.verdict === 'fail').length;
    const falsePositives = controls.filter((r) => r.verdict === 'fail').length;
    const invalidCells = cls.filter((r) => r.verdict === 'invalid').length;
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
 * Serializes the report to CSV with a provenance stamp. {@link stampProvenance} throws on incomplete
 * provenance, and {@link assertMeasured} requires `source: measured`. The stamp goes into `#` lines at the
 * top, which the chart generator skips.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const CSV_OUT = path.join(REPO_ROOT, 'tests/evals/data/2026-07-10/gate-catch-rate.csv');

/**
 * Builds the provenance stamp. The date is fixed, not read from the clock, so the provenance lines of the
 * committed CSV stay the same across runs.
 */
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
  }
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

/** True when the file runs directly (`tsx catch-rate-driver.ts`). An import from a test does not run `main`. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(HERE, 'catch-rate-driver.ts');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
    process.exit(1);
  });
}
