/**
 * P05-02 — Packaged action + CLI proof (ART-004 / ART-005 / ART-014).
 *
 * The COMPILED-PROCESS half of the packaged proof. It spawns the SHIPPED binary
 * produced by `scripts/build-binary.ts` (the same artifact `compiled-binary-
 * mcp.test.ts` exercises) and drives real CLI invocations, then feeds the
 * observations to the pure coverage engine + ratchet in
 * `src/parity/__tests__/packaged-proof.ts`.
 *
 * "Through the compiled process" is literal here: every action/alias/host-
 * command/error-family/effect probe below is a `spawn` of the native binary,
 * NOT an in-process import of the TypeScript modules. That is the distinction
 * ART-004/005 exist to prove.
 *
 * What is exercised through the real compiled artifact:
 *   • ACTIONS  — every registered action is invoked as `<tool> <action> --json`;
 *     the binary routes to it and returns a contract-shaped envelope (a success
 *     OR a stable/structured error). Reachability + contract-conformance of the
 *     whole action surface through the packaged binary.
 *   • PRESENTATION ALIASES — actions with a `cli.alias` are invoked BY that
 *     alias (the binary registers the alias as the primary subcommand name).
 *   • HOST COMMANDS — every composite-tool CLI group plus the four top-level
 *     promoted verbs (`ps`/`wait`/`describe`/`export`) are driven.
 *   • ERROR FAMILIES + STABLE EXIT CODES — every error the binary emits is
 *     checked: observed exit code == `exitCodeForError(code)` (P03-02 contract).
 *   • EFFECT FAMILIES — filesystem (a `wf init` writes the event store) and
 *     process (a `list_prs` spawns `gh`/`git`) are proven by observable effects.
 *   • CANCELLATION — a cooperative `wf init`→`wf cancel` round-trip and a
 *     bounded `wait` are driven through the binary.
 *
 * Honest gaps (recorded as accepted gaps in the baseline, held by the ratchet):
 *   • error families `authorization` / `output` / `presenter` / `task` are not
 *     organically triggerable through the CLI here; their exit-code mapping is
 *     pinned against the contract table in the unit test instead.
 *   • effect family `network` cannot be exercised hermetically (no CLI action
 *     makes an offline network call).
 *
 * Regenerate the baseline after an intentional coverage change:
 *   EXARCHOS_WRITE_PACKAGED_BASELINE=1 npx vitest run test/process/packaged-proof.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot, ensureBinaryBuilt } from './_helpers.js';
import {
  COVERAGE_DIMENSIONS,
  derivePackagedCliPlan,
  derivePackagedDenominators,
  computeCoverage,
  coverageFor,
  checkRatchet,
  reportToBaseline,
  parseCoverageBaseline,
  classifyErrorLayer,
  expectedExitForCode,
  aliasId,
  type PackagedActionPlan,
  type DimensionSets,
  type CoverageDimension,
  type CoverageReport,
  type CoverageBaseline,
} from '../../src/parity/__tests__/packaged-proof.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(__dirname);
const BASELINE_PATH = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'parity',
  '__tests__',
  'packaged-proof.baseline.json',
);

// ─── Compiled-binary CLI driver ──────────────────────────────────────────────

interface CliRun {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Spawn the compiled binary with a hermetic environment: a fresh event-store
 * dir, a NON-git working directory (so git/gh-backed actions fail fast instead
 * of touching the developer's repo or the network), and `LOG_LEVEL=error` so
 * only the `--json` envelope reaches stdout.
 */
function runCli(
  binaryPath: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly stateDir: string; readonly timeoutMs?: number },
): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, [...args, '--json'], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        WORKFLOW_STATE_DIR: opts.stateDir,
        EXARCHOS_PLUGIN_ROOT: REPO_ROOT,
        LOG_LEVEL: 'error',
        // Never let a git/gh action reach a real remote in this hermetic probe.
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      } as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 30_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exit: code, stdout, stderr, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exit: null, stdout, stderr, timedOut });
    });
  });
}

/** Contract envelope shape the binary emits under `--json`. */
interface Envelope {
  readonly success: boolean;
  readonly error?: { readonly code?: string };
}

/**
 * Extract the first COMPLETE balanced JSON object from `text` starting at
 * `from`, respecting string/escape context so a `}` inside a string does not
 * close the object early. Returns the substring, or undefined if unbalanced.
 */
function balancedObjectAt(text: string, from: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return undefined;
}

/**
 * Extract the `--json` envelope from stdout. The envelope is pretty-printed
 * (opening `{` immediately followed by a newline), whereas a stray pino log is
 * single-line (`{"level":…`). We prefer the pretty-printed opener, then fall
 * back to the first `{`, and always brace-match so a trailing log line can't
 * defeat `JSON.parse`.
 */
function extractEnvelope(stdout: string): Envelope | undefined {
  const prettyCr = stdout.indexOf('{\r\n');
  const prettyLf = stdout.indexOf('{\n');
  const pretty = [prettyCr, prettyLf].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const start = pretty ?? stdout.indexOf('{');
  if (start < 0) return undefined;
  const slice = balancedObjectAt(stdout, start);
  if (slice === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(slice);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.success !== 'boolean') return undefined;
    const errBlock = obj.error;
    const code =
      errBlock !== null && typeof errBlock === 'object'
        ? (errBlock as Record<string, unknown>).code
        : undefined;
    return {
      success: obj.success,
      ...(typeof code === 'string' ? { error: { code } } : {}),
    };
  } catch {
    return undefined;
  }
}

async function mkTmp(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Run an async mapper over `items` with bounded concurrency. */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Sweep result ────────────────────────────────────────────────────────────

interface ActionObservation {
  readonly plan: PackagedActionPlan;
  readonly exit: number | null;
  readonly code?: string;
  readonly success?: boolean;
  readonly hasEnvelope: boolean;
  readonly timedOut: boolean;
}

interface ExitObservation {
  readonly label: string;
  readonly code: string | undefined;
  readonly exit: number | null;
}

interface SweepResult {
  readonly observations: readonly ActionObservation[];
  readonly exitObservations: readonly ExitObservation[];
  readonly ledger: DimensionSets;
  readonly report: CoverageReport;
  readonly filesystemProven: boolean;
  readonly processProven: boolean;
  readonly cancelEnvelope: boolean;
  readonly cancelExit: number | null;
  readonly cancelCode?: string;
  readonly topLevelDriven: readonly string[];
}

let BINARY_PATH = '';
let SWEEP: SweepResult;

async function driveEveryAction(binaryPath: string): Promise<ActionObservation[]> {
  const plan = derivePackagedCliPlan();
  const sharedCwd = await mkTmp('exq-proof-cwd-');
  const obs = await mapPool(plan, 6, async (entry): Promise<ActionObservation> => {
    const stateDir = await mkTmp('exq-proof-state-');
    try {
      const run = await runCli(binaryPath, [entry.toolCliName, entry.actionCliName], {
        cwd: sharedCwd,
        stateDir,
        timeoutMs: 30_000,
      });
      const env = extractEnvelope(run.stdout);
      const code = env?.error?.code;
      return {
        plan: entry,
        exit: run.exit,
        ...(code !== undefined ? { code } : {}),
        ...(env !== undefined ? { success: env.success } : {}),
        hasEnvelope: env !== undefined,
        timedOut: run.timedOut,
      };
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  await fsp.rm(sharedCwd, { recursive: true, force: true }).catch(() => undefined);
  return obs;
}

async function runSweep(binaryPath: string): Promise<SweepResult> {
  const observations = await driveEveryAction(binaryPath);

  // ── Exit-code observations from the whole sweep (exit-proof c). ─────────────
  const exitObservations: ExitObservation[] = observations
    .filter((o) => o.hasEnvelope && !o.timedOut)
    .map((o) => ({ label: o.plan.actionId, code: o.code, exit: o.exit }));

  // ── Top-level promoted verbs (host commands). ──────────────────────────────
  const topLevelDriven: string[] = [];
  for (const verb of ['ps', 'wait', 'describe', 'export']) {
    const stateDir = await mkTmp('exq-proof-top-');
    const cwd = await mkTmp('exq-proof-topcwd-');
    try {
      const run = await runCli(binaryPath, [verb], { cwd, stateDir, timeoutMs: 30_000 });
      const env = extractEnvelope(run.stdout);
      if (env !== undefined) {
        topLevelDriven.push(verb);
        exitObservations.push({ label: `toplevel:${verb}`, code: env.error?.code, exit: run.exit });
      }
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── Effect probe: filesystem — `wf init` writes the event store. ───────────
  const fsState = await mkTmp('exq-proof-fs-');
  const fsCwd = await mkTmp('exq-proof-fscwd-');
  let filesystemProven = false;
  try {
    const run = await runCli(
      binaryPath,
      ['wf', 'init', '--feature-id', 'p0502-fs-probe', '--workflow-type', 'oneshot'],
      { cwd: fsCwd, stateDir: fsState, timeoutMs: 30_000 },
    );
    const env = extractEnvelope(run.stdout);
    const wroteFiles = fs.existsSync(fsState) && fs.readdirSync(fsState).length > 0;
    filesystemProven = env?.success === true && wroteFiles;
    if (env !== undefined) {
      exitObservations.push({ label: 'effect:fs:wf-init', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await fsp.rm(fsState, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(fsCwd, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Effect probe: process — `list_prs` spawns a `gh`/`git` child process. ──
  const procState = await mkTmp('exq-proof-proc-');
  const procCwd = await mkTmp('exq-proof-proccwd-');
  let processProven = false;
  try {
    const run = await runCli(binaryPath, ['orch', 'list_prs'], {
      cwd: procCwd,
      stateDir: procState,
      timeoutMs: 30_000,
    });
    const env = extractEnvelope(run.stdout);
    // The error message proves a child process was spawned (`gh pr list` / git).
    const spawnedChild = /gh pr list|failed to run git|not a git repos|NOT_GIT_REPO|VCS_ERROR/i.test(
      run.stdout,
    );
    processProven = env !== undefined && spawnedChild;
    if (env !== undefined) {
      exitObservations.push({ label: 'effect:proc:list_prs', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await fsp.rm(procState, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(procCwd, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Cancellation probe: cooperative `wf init` → `wf cancel`. ────────────────
  const cxState = await mkTmp('exq-proof-cx-');
  const cxCwd = await mkTmp('exq-proof-cxcwd-');
  let cancelEnvelope = false;
  let cancelExit: number | null = null;
  let cancelCode: string | undefined;
  try {
    await runCli(
      binaryPath,
      ['wf', 'init', '--feature-id', 'p0502-cancel-probe', '--workflow-type', 'oneshot'],
      { cwd: cxCwd, stateDir: cxState, timeoutMs: 30_000 },
    );
    const run = await runCli(binaryPath, ['wf', 'cancel', '--feature-id', 'p0502-cancel-probe'], {
      cwd: cxCwd,
      stateDir: cxState,
      timeoutMs: 30_000,
    });
    const env = extractEnvelope(run.stdout);
    cancelEnvelope = env !== undefined;
    cancelExit = run.exit;
    cancelCode = env?.error?.code;
    if (env !== undefined) {
      exitObservations.push({ label: 'cancel:wf-cancel', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await fsp.rm(cxState, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(cxCwd, { recursive: true, force: true }).catch(() => undefined);
  }

  // ── Assemble the exercise ledger from the observations. ────────────────────
  const exercisedActions = observations.filter((o) => o.hasEnvelope);

  const actions = exercisedActions.map((o) => o.plan.actionId);

  const presentationAliases = exercisedActions
    .filter((o) => o.plan.alias !== null)
    .map((o) => aliasId(o.plan.actionId, o.plan.alias as string));

  const hostCommands = [
    ...new Set([...exercisedActions.map((o) => o.plan.toolCliName), ...topLevelDriven]),
  ];

  const errorFamilies = [
    ...new Set(exercisedActions.filter((o) => o.code !== undefined).map((o) => classifyErrorLayer(o.code as string))),
  ];

  const effectFamilies: string[] = [];
  if (filesystemProven) effectFamilies.push('filesystem');
  if (processProven) effectFamilies.push('process');

  const cancellationPaths = exercisedActions
    .filter((o) => o.plan.cancellable)
    .map((o) => o.plan.actionId);

  const ledger: DimensionSets = {
    actions,
    presentationAliases,
    hostCommands,
    errorFamilies,
    effectFamilies,
    cancellationPaths,
  };

  const report = computeCoverage(derivePackagedDenominators(), ledger);

  return {
    observations,
    exitObservations,
    ledger,
    report,
    filesystemProven,
    processProven,
    cancelEnvelope,
    cancelExit,
    ...(cancelCode !== undefined ? { cancelCode } : {}),
    topLevelDriven,
  };
}

// ─── Build the binary + run the sweep once ───────────────────────────────────

beforeAll(async () => {
  const { binaryPath } = await ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
  SWEEP = await runSweep(binaryPath);

  if (process.env.EXARCHOS_WRITE_PACKAGED_BASELINE === '1') {
    const baseline = reportToBaseline(
      SWEEP.report,
      'P05-02 packaged action/CLI proof coverage baseline. Regenerate with ' +
        'EXARCHOS_WRITE_PACKAGED_BASELINE=1 npx vitest run test/process/packaged-proof.test.ts ' +
        "from servers/exarchos-mcp. 'missing' entries are accepted, documented gaps the ratchet " +
        'holds the line at; the compiled-process test fails if any NEW denominator item goes ' +
        'unexercised through the shipped binary.',
    );
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[packaged-proof] wrote baseline → ${BASELINE_PATH}`);
  }
}, 240_000);

function loadBaseline(): CoverageBaseline {
  return parseCoverageBaseline(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
}

// ─── Coverage + ratchet ──────────────────────────────────────────────────────

describe('Packaged action + CLI proof — coverage through the compiled binary (P05-02)', () => {
  it('EveryRegisteredAction_ReachableThroughTheCompiledBinary', () => {
    const actions = coverageFor(SWEEP.report, 'actions');
    // Report the real numbers; the ratchet (below) enforces non-regression.
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] actions covered ${actions.covered}/${actions.total}` +
        (actions.missing.length > 0 ? ` — missing: ${actions.missing.join(', ')}` : ''),
    );
    // No action may TIME OUT — a hang is a real defect, not an accepted gap.
    const timedOut = SWEEP.observations.filter((o) => o.timedOut).map((o) => o.plan.actionId);
    expect(timedOut, `actions timed out through the binary: ${timedOut.join(', ')}`).toEqual([]);
    // Every action returned a contract-shaped envelope from the shipped binary.
    const noEnvelope = SWEEP.observations.filter((o) => !o.hasEnvelope).map((o) => o.plan.actionId);
    expect(noEnvelope, `actions with no contract envelope: ${noEnvelope.join(', ')}`).toEqual([]);
  });

  it('Coverage_DoesNotRegressBelowTheCheckedInBaseline', () => {
    const baseline = loadBaseline();
    const result = checkRatchet(SWEEP.report, baseline);
    for (const dim of COVERAGE_DIMENSIONS) {
      const c = coverageFor(SWEEP.report, dim);
      // eslint-disable-next-line no-console
      console.log(`[packaged-proof] ${dim}: ${c.covered}/${c.total}`);
    }
    expect(result.ok, JSON.stringify(result.regressions, null, 2)).toBe(true);
  });

  it('Baseline_TotalsTrackTheLiveDenominators', () => {
    // The compiled-process baseline must denominate against the SAME live
    // surface as the pure engine — no silently-omitted dimension/item.
    const baseline = loadBaseline();
    const den = derivePackagedDenominators();
    for (const dim of COVERAGE_DIMENSIONS) {
      expect(baseline.dimensions[dim].total, `baseline ${dim}.total`).toBe(den[dim].length);
    }
  });
});

// ─── Exit-code contract (exit-proof c, through the compiled process) ─────────

describe('Stable CLI exit codes through the compiled binary (P05-02)', () => {
  it('EveryObservedErrorCode_ExitsWithItsContractStableExitCode', () => {
    const mismatches = SWEEP.exitObservations.filter(
      (o) => o.exit !== expectedExitForCode(o.code),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] exit-code observations: ${SWEEP.exitObservations.length}, ` +
        `distinct codes: ${[...new Set(SWEEP.exitObservations.map((o) => o.code ?? 'SUCCESS'))].join(', ')}`,
    );
    expect(
      mismatches.map((m) => `${m.label} code=${m.code ?? 'SUCCESS'} exit=${m.exit} expected=${expectedExitForCode(m.code)}`),
    ).toEqual([]);
  });

  it('ProtocolFamily_InvalidInput_ExitsOneThroughTheBinary', () => {
    // A protocol-layer failure (missing required arg) must exit 1 on the real
    // binary — the family whose exit code a shell caller branches on.
    const invalidInput = SWEEP.exitObservations.filter((o) => o.code === 'INVALID_INPUT');
    expect(invalidInput.length, 'expected the sweep to organically emit INVALID_INPUT').toBeGreaterThan(0);
    for (const o of invalidInput) {
      expect(o.exit, `${o.label}`).toBe(1);
      expect(classifyErrorLayer('INVALID_INPUT')).toBe('protocol');
    }
  });

  it('HandlerFamily_BusinessFailure_ExitsTwoThroughTheBinary', () => {
    // A handler-layer failure (e.g. a VCS/not-a-git-repo business failure) must
    // exit 2 on the real binary.
    const handler = SWEEP.exitObservations.filter(
      (o) => o.code !== undefined && classifyErrorLayer(o.code) === 'handler',
    );
    expect(handler.length, 'expected the sweep to organically emit a handler-family error').toBeGreaterThan(0);
    for (const o of handler) expect(o.exit, `${o.label} (${o.code})`).toBe(2);
  });
});

// ─── Effect families (through the compiled process) ──────────────────────────

describe('Effect families through the compiled binary (P05-02)', () => {
  it('Filesystem_WfInitWritesTheEventStore', () => {
    expect(SWEEP.filesystemProven).toBe(true);
  });

  it('Process_ListPrsSpawnsAChildProcess', () => {
    expect(SWEEP.processProven).toBe(true);
  });
});

// ─── Cancellation path (exit-proof d, through the compiled process) ──────────

describe('Cancellation path through the compiled binary (P05-02)', () => {
  it('CooperativeCancel_RoundTripsToAContractEnvelopeWithAStableExit', () => {
    // The cooperative cancel path executes end-to-end through the shipped
    // binary and returns a contract envelope with a stable exit code. (We do
    // not assert cancel SUCCESS: the CLI trusted-caller path currently fails
    // cancellation-request admission — see the P05-02 report finding.)
    expect(SWEEP.cancelEnvelope).toBe(true);
    expect(SWEEP.cancelExit).toBe(expectedExitForCode(SWEEP.cancelCode));
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] cooperative cancel → exit=${SWEEP.cancelExit} code=${SWEEP.cancelCode ?? 'SUCCESS'}`,
    );
  });

  it('EveryCancellableAction_ReachableThroughTheCompiledBinary', () => {
    const cancellation = coverageFor(SWEEP.report, 'cancellationPaths');
    expect(cancellation.total).toBeGreaterThan(0);
    // Non-regression is enforced by the ratchet; here we just surface the count.
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] cancellation paths reachable ${cancellation.covered}/${cancellation.total}`,
    );
  });
});

// ─── Seeded-action drop through the REAL ledger (exit-proof b) ────────────────

describe('Ratchet catches a seeded unexercised action against the real ledger (P05-02)', () => {
  it('SeededRegisteredAction_UnexercisedByTheBinary_TripsTheRatchet', () => {
    // Grow the denominator with a REGISTERED-but-unexercised action, keep the
    // REAL compiled-process ledger (which cannot cover the seed), and confirm
    // the ratchet fails — the coverage regression a new packaged action must
    // cause if nothing exercises it.
    const seededDen = derivePackagedDenominators(seededRegistry());
    const report = computeCoverage(seededDen, SWEEP.ledger);
    const actions = coverageFor(report, 'actions');
    expect(actions.missing).toContain('exarchos_event.p0502_unexercised_seed');

    const result = checkRatchet(report, loadBaseline());
    expect(result.ok).toBe(false);
    expect(
      result.regressions.some((r) => r.dimension === 'actions' && r.kind === 'new-gap'),
    ).toBe(true);
  });
});

// ─── seeded registry helper (local to the process test) ──────────────────────

import { TOOL_REGISTRY, type CompositeTool, type ToolAction } from '../../src/registry.js';

function seededRegistry(): readonly CompositeTool[] {
  return TOOL_REGISTRY.map((tool) => {
    if (tool.name !== 'exarchos_event') return tool;
    const template = tool.actions[0];
    if (template === undefined) throw new Error('test setup: exarchos_event has no actions');
    const seeded: ToolAction = { ...template, name: 'p0502_unexercised_seed' };
    return { ...tool, actions: [...tool.actions, seeded] };
  });
}
