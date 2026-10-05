/**
 * The compiled-process half of the packaged proof. Each probe is a `spawn` of the shipped binary
 * from `tools/release/build-binary.ts`, not an in-process import. The observations go to the
 * coverage engine and the ratchet in `tools/conformance/src/parity/__tests__/packaged-proof.ts`.
 *
 * - Actions: each registered action runs as `<tool> <action> --json` and must return a contract
 *   envelope. An action with a `cli.alias` runs by that alias.
 * - Host commands: each composite-tool CLI group and each top-level promoted verb.
 * - Exit codes: the exit of each observed error must equal the stable exit code of its error code.
 * - Effects: `wf init` writes the event store, and `list_prs` spawns `gh` or `git`.
 * - Cancellation: a `wf init` and then a `wf cancel`.
 *
 * The baseline records the accepted gaps: the error families `authorization`, `output`,
 * `presenter` and `task`, and the effect family `network`. To write a new baseline, set
 * `EXARCHOS_WRITE_PACKAGED_BASELINE=1` and run this file with `--project core`.
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
} from '../../../tools/conformance/src/parity/__tests__/packaged-proof.js';
import { EXEC_TIMEOUT_MS } from '../../../src/vcs/shell.js';

/**
 * The harness budget for one spawn of the compiled binary. It must stay above
 * {@link EXEC_TIMEOUT_MS}, the budget that the binary gives its own child CLIs (`gh`, `git`). This
 * timer starts at the spawn, and the inner timer starts after the binary boots. With equal
 * values, this timer kills a slow `gh` before the action turns the inner timeout into a
 * `VCS_ERROR` envelope. The sweep then scores a bounded failure as a hang. On Windows runners,
 * `gh pr list` can take more than 30 s. The doubled value still fails a real hang.
 */
const CLI_TIMEOUT_MS = EXEC_TIMEOUT_MS * 2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(__dirname);
/** The checked-in coverage baseline. It sits beside the coverage engine in the conformance package. */
const BASELINE_PATH = path.join(
  REPO_ROOT,
  'tools',
  'conformance',
  'src',
  'parity',
  '__tests__',
  'packaged-proof.baseline.json',
);

interface CliRun {
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Spawns the compiled binary with `--json` in a hermetic environment. Each caller passes a fresh
 * state directory and a working directory that is not a git repository. So a git or `gh` action
 * fails fast and does not touch the repository of the developer. The empty `GH_TOKEN` and
 * `GITHUB_TOKEN` values keep such an action away from a real remote. `LOG_LEVEL=error` keeps log
 * lines out of stdout, where the envelope goes.
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
    }, opts.timeoutMs ?? CLI_TIMEOUT_MS);

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

/** The part of the contract envelope that the tests read. The binary prints it under `--json`. */
interface Envelope {
  readonly success: boolean;
  readonly error?: { readonly code?: string };
}

/**
 * Returns the first complete JSON object in `text` that starts at `from`, or `undefined` when the
 * braces do not balance. It tracks strings and escapes, so a `}` inside a string does not close
 * the object.
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
 * Extracts the `--json` envelope from stdout. The envelope is pretty-printed, so a newline follows
 * its opening `{`. A stray pino log line is one line (`{"level":…`). The function prefers the
 * pretty-printed opener and falls back to the first `{`. It matches braces, so a log line after
 * the envelope does not break `JSON.parse`.
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

/** Runs an async mapper over `items` with at most `concurrency` calls at a time. */
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

/**
 * Runs each action of the CLI plan as `<tool> <action> --json`, six at a time. Each run has its
 * own state directory, and all runs share one working directory.
 */
async function driveEveryAction(binaryPath: string): Promise<ActionObservation[]> {
  const plan = derivePackagedCliPlan();
  const sharedCwd = await mkTmp('exq-proof-cwd-');
  const obs = await mapPool(plan, 6, async (entry): Promise<ActionObservation> => {
    const stateDir = await mkTmp('exq-proof-state-');
    try {
      const run = await runCli(binaryPath, [entry.toolCliName, entry.actionCliName], {
        cwd: sharedCwd,
        stateDir,
        timeoutMs: CLI_TIMEOUT_MS,
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
      await rmrfAsync(stateDir).catch(() => undefined);
    }
  });
  await rmrfAsync(sharedCwd).catch(() => undefined);
  return obs;
}

/**
 * Runs the whole sweep and builds the exercise ledger and the coverage report.
 *
 * The top-level verbs come from the `cli.topLevel` hints of the registry, so the sweep drives a
 * new promoted verb when the registry declares it. Each verb runs with no arguments. A read-only
 * verb gives a result envelope. A mutating verb such as `merge-orchestrate` fails with
 * `INVALID_INPUT` for its absent flags and has no effect. Both prove that the binary routes the
 * verb through the contract envelope.
 *
 * The filesystem probe is a `wf init` that must succeed and leave files in the state directory.
 * The process probe is `orch list_prs`. It passes when the run gives an envelope and stdout names
 * a `gh` or git failure.
 */
async function runSweep(binaryPath: string): Promise<SweepResult> {
  const observations = await driveEveryAction(binaryPath);

  const exitObservations: ExitObservation[] = observations
    .filter((o) => o.hasEnvelope && !o.timedOut)
    .map((o) => ({ label: o.plan.actionId, code: o.code, exit: o.exit }));

  const promotedVerbs = [
    ...new Set(
      derivePackagedCliPlan()
        .filter((p) => p.topLevel !== null)
        .map((p) => p.topLevel as string),
    ),
  ].sort();
  const topLevelDriven: string[] = [];
  for (const verb of promotedVerbs) {
    const stateDir = await mkTmp('exq-proof-top-');
    const cwd = await mkTmp('exq-proof-topcwd-');
    try {
      const run = await runCli(binaryPath, [verb], { cwd, stateDir, timeoutMs: CLI_TIMEOUT_MS });
      const env = extractEnvelope(run.stdout);
      if (env !== undefined) {
        topLevelDriven.push(verb);
        exitObservations.push({ label: `toplevel:${verb}`, code: env.error?.code, exit: run.exit });
      }
    } finally {
      await rmrfAsync(stateDir).catch(() => undefined);
      await rmrfAsync(cwd).catch(() => undefined);
    }
  }

  const fsState = await mkTmp('exq-proof-fs-');
  const fsCwd = await mkTmp('exq-proof-fscwd-');
  let filesystemProven = false;
  try {
    const run = await runCli(
      binaryPath,
      ['wf', 'init', '--feature-id', 'p0502-fs-probe', '--workflow-type', 'oneshot'],
      { cwd: fsCwd, stateDir: fsState, timeoutMs: CLI_TIMEOUT_MS },
    );
    const env = extractEnvelope(run.stdout);
    const wroteFiles = fs.existsSync(fsState) && fs.readdirSync(fsState).length > 0;
    filesystemProven = env?.success === true && wroteFiles;
    if (env !== undefined) {
      exitObservations.push({ label: 'effect:fs:wf-init', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await rmrfAsync(fsState).catch(() => undefined);
    await rmrfAsync(fsCwd).catch(() => undefined);
  }

  const procState = await mkTmp('exq-proof-proc-');
  const procCwd = await mkTmp('exq-proof-proccwd-');
  let processProven = false;
  try {
    const run = await runCli(binaryPath, ['orch', 'list_prs'], {
      cwd: procCwd,
      stateDir: procState,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const env = extractEnvelope(run.stdout);
    const spawnedChild = /gh pr list|failed to run git|not a git repos|NOT_GIT_REPO|VCS_ERROR/i.test(
      run.stdout,
    );
    processProven = env !== undefined && spawnedChild;
    if (env !== undefined) {
      exitObservations.push({ label: 'effect:proc:list_prs', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await rmrfAsync(procState).catch(() => undefined);
    await rmrfAsync(procCwd).catch(() => undefined);
  }

  const cxState = await mkTmp('exq-proof-cx-');
  const cxCwd = await mkTmp('exq-proof-cxcwd-');
  let cancelEnvelope = false;
  let cancelExit: number | null = null;
  let cancelCode: string | undefined;
  try {
    await runCli(
      binaryPath,
      ['wf', 'init', '--feature-id', 'p0502-cancel-probe', '--workflow-type', 'oneshot'],
      { cwd: cxCwd, stateDir: cxState, timeoutMs: CLI_TIMEOUT_MS },
    );
    const run = await runCli(binaryPath, ['wf', 'cancel', '--feature-id', 'p0502-cancel-probe'], {
      cwd: cxCwd,
      stateDir: cxState,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const env = extractEnvelope(run.stdout);
    cancelEnvelope = env !== undefined;
    cancelExit = run.exit;
    cancelCode = env?.error?.code;
    if (env !== undefined) {
      exitObservations.push({ label: 'cancel:wf-cancel', code: env.error?.code, exit: run.exit });
    }
  } finally {
    await rmrfAsync(cxState).catch(() => undefined);
    await rmrfAsync(cxCwd).catch(() => undefined);
  }

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

/**
 * Builds the binary and runs the sweep one time for all tests. With
 * `EXARCHOS_WRITE_PACKAGED_BASELINE=1`, the hook also writes the baseline file from the report.
 */
beforeAll(async () => {
  const { binaryPath } = await ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
  SWEEP = await runSweep(binaryPath);

  if (process.env.EXARCHOS_WRITE_PACKAGED_BASELINE === '1') {
    const baseline = reportToBaseline(
      SWEEP.report,
      'P05-02 packaged action/CLI proof coverage baseline. Regenerate with ' +
        'EXARCHOS_WRITE_PACKAGED_BASELINE=1 npx vitest run --project core ' +
        "tests/core/process/packaged-proof.test.ts from the repo root. 'missing' entries are " +
        'accepted, documented gaps the ratchet holds the line at; the compiled-process test ' +
        'fails if any NEW denominator item goes unexercised through the shipped binary.',
    );
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[packaged-proof] wrote baseline → ${BASELINE_PATH}`);
  }
}, 240_000);

function loadBaseline(): CoverageBaseline {
  return parseCoverageBaseline(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
}

describe('Packaged action + CLI proof — coverage through the compiled binary (P05-02)', () => {
  /**
   * No action can time out, because a hang is a defect and not an accepted gap. Each action must
   * return a contract envelope. The ratchet test enforces the coverage count.
   */
  it('EveryRegisteredAction_ReachableThroughTheCompiledBinary', () => {
    const actions = coverageFor(SWEEP.report, 'actions');
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] actions covered ${actions.covered}/${actions.total}` +
        (actions.missing.length > 0 ? ` — missing: ${actions.missing.join(', ')}` : ''),
    );
    const timedOut = SWEEP.observations.filter((o) => o.timedOut).map((o) => o.plan.actionId);
    expect(timedOut, `actions timed out through the binary: ${timedOut.join(', ')}`).toEqual([]);
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

  /** Each baseline total must equal the live denominator, so the baseline omits no item. */
  it('Baseline_TotalsTrackTheLiveDenominators', () => {
    const baseline = loadBaseline();
    const den = derivePackagedDenominators();
    for (const dim of COVERAGE_DIMENSIONS) {
      expect(baseline.dimensions[dim].total, `baseline ${dim}.total`).toBe(den[dim].length);
    }
  });
});

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

  /**
   * A protocol failure, such as an absent required argument, must exit 1. A shell caller branches
   * on the exit code of this family.
   */
  it('ProtocolFamily_InvalidInput_ExitsOneThroughTheBinary', () => {
    const invalidInput = SWEEP.exitObservations.filter((o) => o.code === 'INVALID_INPUT');
    expect(invalidInput.length, 'expected the sweep to organically emit INVALID_INPUT').toBeGreaterThan(0);
    for (const o of invalidInput) {
      expect(o.exit, `${o.label}`).toBe(1);
      expect(classifyErrorLayer('INVALID_INPUT')).toBe('protocol');
    }
  });

  /** A handler failure, such as a VCS failure outside a git repository, must exit 2. */
  it('HandlerFamily_BusinessFailure_ExitsTwoThroughTheBinary', () => {
    const handler = SWEEP.exitObservations.filter(
      (o) => o.code !== undefined && classifyErrorLayer(o.code) === 'handler',
    );
    expect(handler.length, 'expected the sweep to organically emit a handler-family error').toBeGreaterThan(0);
    for (const o of handler) expect(o.exit, `${o.label} (${o.code})`).toBe(2);
  });
});

describe('Effect families through the compiled binary (P05-02)', () => {
  it('Filesystem_WfInitWritesTheEventStore', () => {
    expect(SWEEP.filesystemProven).toBe(true);
  });

  it('Process_ListPrsSpawnsAChildProcess', () => {
    expect(SWEEP.processProven).toBe(true);
  });
});

describe('Cancellation path through the compiled binary (P05-02)', () => {
  /**
   * The `wf cancel` call must return a contract envelope, and its exit must be the stable exit
   * code of its error code. The test does not assert that the cancel succeeds, so a cancel that
   * fails with the matching exit code also passes.
   */
  it('CooperativeCancel_RoundTripsToAContractEnvelopeWithAStableExit', () => {
    expect(SWEEP.cancelEnvelope).toBe(true);
    expect(SWEEP.cancelExit).toBe(expectedExitForCode(SWEEP.cancelCode));
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] cooperative cancel → exit=${SWEEP.cancelExit} code=${SWEEP.cancelCode ?? 'SUCCESS'}`,
    );
  });

  /**
   * Asserts only that the registry declares at least one cancellable action, and logs the covered
   * count. The ratchet test enforces the coverage.
   */
  it('EveryCancellableAction_ReachableThroughTheCompiledBinary', () => {
    const cancellation = coverageFor(SWEEP.report, 'cancellationPaths');
    expect(cancellation.total).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[packaged-proof] cancellation paths reachable ${cancellation.covered}/${cancellation.total}`,
    );
  });
});

describe('Ratchet catches a seeded unexercised action against the real ledger (P05-02)', () => {
  /**
   * The denominator gets one registered action that nothing exercises, and the ledger stays the
   * real one. The ratchet must then fail with a `new-gap` regression for `actions`.
   */
  it('SeededRegisteredAction_UnexercisedByTheBinary_TripsTheRatchet', () => {
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

import { TOOL_REGISTRY, type CompositeTool, type ToolAction } from '../../../src/registry.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** Returns the registry with one more `exarchos_event` action, `p0502_unexercised_seed`. */
function seededRegistry(): readonly CompositeTool[] {
  return TOOL_REGISTRY.map((tool) => {
    if (tool.name !== 'exarchos_event') return tool;
    const template = tool.actions[0];
    if (template === undefined) throw new Error('test setup: exarchos_event has no actions');
    const seeded: ToolAction = { ...template, name: 'p0502_unexercised_seed' };
    return { ...tool, actions: [...tool.actions, seeded] };
  });
}
